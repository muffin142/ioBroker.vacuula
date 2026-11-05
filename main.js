'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const utils = require('@iobroker/adapter-core');

/** Timeout for a single HTTP request against the Vacuula server (ms) */
const REQUEST_TIMEOUT = 10000;
/** Lower bound for the polling interval (s) */
const MIN_POLL_INTERVAL = 5;

/**
 * States which are filled from the response of the "getRobotState" command.
 * Key = state id relative to the robot device, path = location inside the response.
 *
 * @type {Record<string, {path: string[], common: Partial<ioBroker.StateCommon>}>}
 */
const ROBOT_STATES = {
	'info.modelName': {
		path: ['meta', 'modelName'],
		common: { name: 'Model name', type: 'string', role: 'text', read: true, write: false },
	},
	'info.firmware': {
		path: ['meta', 'firmware'],
		common: { name: 'Firmware', type: 'string', role: 'info.firmware', read: true, write: false },
	},
	'status.isCharging': {
		path: ['details', 'isCharging'],
		common: { name: 'Is charging', type: 'boolean', role: 'indicator', read: true, write: false },
	},
	'status.isDocked': {
		path: ['details', 'isDocked'],
		common: { name: 'Is docked', type: 'boolean', role: 'indicator', read: true, write: false },
	},
	'status.isScheduleEnabled': {
		path: ['details', 'isScheduleEnabled'],
		common: { name: 'Schedule enabled', type: 'boolean', role: 'indicator', read: true, write: false },
	},
	'status.dockHasBeenSeen': {
		path: ['details', 'dockHasBeenSeen'],
		common: { name: 'Dock has been seen', type: 'boolean', role: 'indicator', read: true, write: false },
	},
	'status.error': {
		path: ['error'],
		common: { name: 'Error message', type: 'string', role: 'indicator', read: true, write: false },
	},
	'status.alert': {
		path: ['alert'],
		common: { name: 'Alert message', type: 'string', role: 'indicator', read: true, write: false },
	},
	'status.state': {
		path: ['state'],
		common: {
			name: 'State',
			type: 'number',
			role: 'indicator',
			read: true,
			write: false,
			states: { 1: 'Idle', 2: 'Cleaning', 3: 'Paused', 4: 'Docking' },
		},
	},
	'status.action': {
		path: ['action'],
		common: {
			name: 'Action',
			type: 'number',
			role: 'indicator',
			read: true,
			write: false,
			states: { 4: 'Docking', 9: 'Recovering location', 11: 'Cleaning', 13: 'Acquiring map IDs' },
		},
	},
	'status.charge': {
		path: ['details', 'charge'],
		common: {
			name: 'Battery charge',
			type: 'number',
			role: 'value.battery',
			unit: '%',
			min: 0,
			max: 100,
			read: true,
			write: false,
		},
	},
	'cleaning.category': {
		path: ['cleaning', 'category'],
		common: {
			name: 'Mode',
			type: 'number',
			role: 'level',
			states: { 2: 'House', 3: 'Spot', 4: 'Map' },
			read: true,
			write: true,
		},
	},
	'cleaning.mode': {
		path: ['cleaning', 'mode'],
		common: {
			name: 'Cleaning',
			type: 'number',
			role: 'level',
			states: { 1: 'Eco', 2: 'Normal' },
			read: true,
			write: true,
		},
	},
	'cleaning.modifier': {
		path: ['cleaning', 'modifier'],
		common: {
			name: 'Modifier',
			type: 'number',
			role: 'value',
			states: { 1: 'Normal', 2: 'Intensive' },
			min: 1,
			max: 2,
			read: true,
			write: true,
		},
	},
	'cleaning.navigationMode': {
		path: ['cleaning', 'navigationMode'],
		common: {
			name: 'Navigation mode',
			type: 'number',
			role: 'level',
			states: { 1: 'Normal', 2: 'Extra Care', 3: 'Deep' },
			read: true,
			write: true,
		},
	},
	'cleaning.spotWidth': {
		path: ['cleaning', 'spotWidth'],
		common: { name: 'Spot width', type: 'number', role: 'level', unit: 'cm', min: 0, read: true, write: true },
	},
	'cleaning.spotHeight': {
		path: ['cleaning', 'spotHeight'],
		common: { name: 'Spot height', type: 'number', role: 'level', unit: 'cm', min: 0, read: true, write: true },
	},
};

/**
 * Command buttons. "cmd" is sent as payload, "start" builds its parameters from the cleaning states.
 *
 * @type {Record<string, {name: string, cmd: string}>}
 */
const COMMANDS = {
	findMe: { name: 'Locate robot', cmd: 'findMe' },
	start: { name: 'Start cleaning', cmd: 'startCleaning' },
	pause: { name: 'Pause cleaning', cmd: 'pauseCleaning' },
	resume: { name: 'Resume cleaning', cmd: 'resumeCleaning' },
	stop: { name: 'Stop cleaning', cmd: 'stopCleaning' },
};

/** Category value for spot cleaning – only then spotWidth/spotHeight are sent */
const CATEGORY_SPOT = 3;

class Vacuula extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'vacuula',
		});

		/** @type {string} */
		this.baseUrl = '';
		/** Map of object id (sanitized) -> robot id on the Vacuula server */
		/** @type {Map<string, string>} */
		this.robots = new Map();
		/** Robots whose objects have already been created/updated during this run */
		/** @type {Set<string>} */
		this.initializedRobots = new Set();
		/** Keys of currently active errors, used to avoid flooding the log on every poll */
		/** @type {Set<string>} */
		this.activeErrors = new Set();
		/** @type {ioBroker.Timeout | undefined} */
		this.pollTimer = undefined;
		/** Polling interval in ms, set from the config in onReady */
		this.pollIntervalMs = 30000;
		this.unloading = false;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState('info.connection', false, true);

		const protocol = this.config.protocol === 'https' ? 'https' : 'http';
		const host = (this.config.host || '').trim().replace(/\/+$/, '');
		if (!host) {
			this.log.error('No Vacuula server address configured. Please check the adapter settings.');
			return;
		}
		this.baseUrl = `${protocol}://${host}`;

		let interval = Number(this.config.pollInterval);
		if (!Number.isFinite(interval) || interval < MIN_POLL_INTERVAL) {
			this.log.warn(
				`Invalid polling interval "${this.config.pollInterval}", using minimum of ${MIN_POLL_INTERVAL} seconds`,
			);
			interval = MIN_POLL_INTERVAL;
		}
		this.pollIntervalMs = interval * 1000;

		this.log.info(`Using Vacuula server ${this.baseUrl}, polling every ${interval} s`);

		// Restore known robots from previous runs, so commands work before the first poll finished,
		// and reset their connection state until the server confirms it.
		const devices = await this.getDevicesAsync();
		for (const device of devices) {
			const objId = device._id.substring(this.namespace.length + 1);
			const robotId = device.native && device.native.robotId;
			if (robotId) {
				this.robots.set(objId, robotId);
				await this.setState(`${objId}.connected`, false, true);
			}
		}

		this.subscribeStates('*.commands.*');

		await this.poll();
	}

	/**
	 * Queries all robots and their states, then schedules the next run.
	 */
	async poll() {
		if (this.pollTimer) {
			this.clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}

		try {
			await this.updateRobots();
		} catch (error) {
			// updateRobots handles its own errors, this is only a safety net
			this.log.error(`Unexpected error while polling: ${error.message}`);
		}

		if (!this.unloading) {
			this.pollTimer = this.setTimeout(() => {
				this.pollTimer = undefined;
				this.poll();
			}, this.pollIntervalMs);
		}
	}

	/**
	 * Fetches the robot list and updates name/connected plus the detailed state of each connected robot.
	 */
	async updateRobots() {
		/** @type {Record<string, {name?: string, connected?: boolean, type?: string}>} */
		let robotList;
		try {
			robotList = await this.request('GET', '/api/robots');
			if (!robotList || typeof robotList !== 'object' || Array.isArray(robotList)) {
				throw new Error(`unexpected response: ${JSON.stringify(robotList)}`);
			}
		} catch (error) {
			this.reportError('server', `Cannot fetch robot list from ${this.baseUrl}/api/robots: ${error.message}`);
			// also covers HTTP errors / invalid answers of the robot list, the server is not usable then
			await this.setConnected(false);
			for (const objId of this.robots.keys()) {
				await this.setState(`${objId}.connected`, false, true);
			}
			return;
		}

		this.clearError('server', `Connection to Vacuula server ${this.baseUrl} established`);

		const seen = new Set();
		for (const [robotId, robot] of Object.entries(robotList)) {
			const objId = this.toObjectId(robotId);
			seen.add(objId);
			this.robots.set(objId, robotId);

			const name = robot && robot.name ? String(robot.name) : robotId;
			const connected = !!(robot && robot.connected);

			try {
				if (!this.initializedRobots.has(objId)) {
					await this.createRobotObjects(objId, robotId, name);
					this.initializedRobots.add(objId);
				} else {
					// keep folder description in sync if the robot was renamed
					await this.extendObject(objId, { common: { name } });
				}

				await this.setState(`${objId}.name`, name, true);
				await this.setState(`${objId}.connected`, connected, true);
			} catch (error) {
				this.log.error(`Cannot create/update objects for robot ${robotId}: ${error.message}`);
				continue;
			}

			if (connected) {
				await this.updateRobotState(objId, robotId);
			} else {
				this.log.debug(`Robot ${name} (${robotId}) is not connected, skipping state query`);
			}
		}

		// robots no longer reported by the server
		for (const objId of this.robots.keys()) {
			if (!seen.has(objId)) {
				await this.setState(`${objId}.connected`, false, true);
			}
		}
	}

	/**
	 * Queries "getRobotState" for one robot and writes the result into the states.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {string} robotId - Robot id on the Vacuula server
	 */
	async updateRobotState(objId, robotId) {
		const errorKey = `state:${robotId}`;
		let data;
		try {
			data = await this.sendCommand(robotId, { cmd: 'getRobotState' });
		} catch (error) {
			this.reportError(errorKey, `Cannot query state of robot ${robotId}: ${error.message}`);
			return;
		}
		this.clearError(errorKey, `State of robot ${robotId} available again`);

		for (const [stateId, def] of Object.entries(ROBOT_STATES)) {
			const raw = def.path.reduce((obj, key) => (obj == null ? undefined : obj[key]), data);
			if (raw === undefined) {
				// field not contained in the response -> keep last value
				continue;
			}

			// null means "no value" (e.g. error: null) -> clear the state instead of keeping the old value
			let value = raw;
			if (def.common.type === 'string') {
				value = raw === null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
			}

			const fullId = `${objId}.${stateId}`;
			if (def.common.write) {
				// Do not overwrite a value the user has just set (ack=false) and not yet used to start a cleaning.
				const current = await this.getStateAsync(fullId);
				if (current && current.ack === false) {
					continue;
				}
			}
			await this.setState(fullId, { val: value, ack: true });
		}
	}

	/**
	 * Creates (or updates) the device, channels and states for one robot.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @param {string} name - Robot name
	 */
	async createRobotObjects(objId, robotId, name) {
		await this.extendObject(objId, {
			type: 'device',
			common: {
				name,
				statusStates: { onlineId: `${this.namespace}.${objId}.connected` },
			},
			native: { robotId },
		});

		await this.extendObject(`${objId}.name`, {
			type: 'state',
			common: { name: 'Name', type: 'string', role: 'info.name', read: true, write: false },
			native: {},
		});
		await this.extendObject(`${objId}.connected`, {
			type: 'state',
			common: { name: 'Connected', type: 'boolean', role: 'indicator.reachable', read: true, write: false },
			native: {},
		});

		const channels = {
			info: 'Information',
			status: 'Status',
			cleaning: 'Cleaning settings',
			commands: 'Commands',
		};
		for (const [channel, channelName] of Object.entries(channels)) {
			await this.extendObject(`${objId}.${channel}`, {
				type: 'channel',
				common: { name: channelName },
				native: {},
			});
		}

		for (const [stateId, def] of Object.entries(ROBOT_STATES)) {
			await this.extendObject(`${objId}.${stateId}`, {
				type: 'state',
				common: /** @type {ioBroker.StateCommon} */ (def.common),
				native: {},
			});
		}

		for (const [command, def] of Object.entries(COMMANDS)) {
			await this.extendObject(`${objId}.commands.${command}`, {
				type: 'state',
				common: {
					name: def.name,
					type: 'boolean',
					role: 'button',
					read: false,
					write: true,
					def: false,
				},
				native: {},
			});
		}
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	async onStateChange(id, state) {
		if (!state || state.ack || !state.val) {
			return;
		}

		// <namespace>.<objId>.commands.<command>
		const parts = id.substring(this.namespace.length + 1).split('.');
		if (parts.length !== 3 || parts[1] !== 'commands') {
			return;
		}
		const [objId, , command] = parts;
		const def = COMMANDS[command];
		const robotId = this.robots.get(objId);

		if (!def) {
			this.log.warn(`Unknown command "${command}"`);
			return;
		}
		if (!robotId) {
			this.log.warn(`Unknown robot "${objId}", cannot execute command "${command}"`);
			return;
		}
		if (!this.baseUrl) {
			this.log.error(`Cannot execute command "${command}": no Vacuula server configured`);
			return;
		}

		try {
			/** @type {{cmd: string, params?: Record<string, number>}} */
			const payload = { cmd: def.cmd };
			if (command === 'start') {
				payload.params = await this.buildStartParams(objId);
			}

			this.log.info(`Sending "${def.cmd}" to robot ${robotId}: ${JSON.stringify(payload)}`);
			await this.sendCommand(robotId, payload);
			this.log.debug(`Command "${def.cmd}" for robot ${robotId} accepted`);
		} catch (error) {
			this.log.error(`Command "${def.cmd}" for robot ${robotId} failed: ${error.message}`);
		} finally {
			await this.setState(id, false, true);
		}

		// refresh state so availableCommands / cleaning values reflect the new situation
		await this.updateRobotState(objId, robotId);
	}

	/**
	 * Reads the cleaning states of a robot and builds the "startCleaning" parameters.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @returns {Promise<Record<string, number>>} parameters for the start command
	 */
	async buildStartParams(objId) {
		const keys = ['category', 'mode', 'navigationMode'];
		const category = await this.readNumberState(`${objId}.cleaning.category`);
		if (category === CATEGORY_SPOT) {
			keys.push('spotHeight', 'spotWidth');
		}

		/** @type {Record<string, number>} */
		const params = {};
		for (const key of keys) {
			params[key] = await this.readNumberState(`${objId}.cleaning.${key}`);
		}
		return params;
	}

	/**
	 * @param {string} id - State id
	 * @returns {Promise<number>} numeric value of the state
	 */
	async readNumberState(id) {
		const state = await this.getStateAsync(id);
		const value = state ? Number(state.val) : NaN;
		if (state == null || state.val === null || state.val === '' || !Number.isFinite(value)) {
			throw new Error(`state ${id} has no valid numeric value`);
		}
		return value;
	}

	/**
	 * Sends a command to a robot and checks the result.
	 *
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @param {object} payload - Command payload
	 * @returns {Promise<any>} the parsed response
	 */
	async sendCommand(robotId, payload) {
		const data = await this.request('POST', `/api/robot/${encodeURIComponent(robotId)}/command`, payload);
		if (!data || typeof data !== 'object') {
			throw new Error(`unexpected response: ${JSON.stringify(data)}`);
		}
		if (data.result !== undefined && data.result !== 'ok') {
			throw new Error(`robot answered "${data.result}"${data.error ? ` (${JSON.stringify(data.error)})` : ''}`);
		}
		if (data.alert) {
			this.log.warn(`Robot ${robotId} reports alert: ${JSON.stringify(data.alert)}`);
		}
		return data;
	}

	/**
	 * Performs a HTTP request against the Vacuula server and returns the parsed JSON body.
	 *
	 * @param {'GET' | 'POST'} method - HTTP method
	 * @param {string} path - Path starting with "/"
	 * @param {object} [body] - JSON body
	 * @returns {Promise<any>} parsed response
	 */
	async request(method, path, body) {
		const url = `${this.baseUrl}${path}`;
		this.log.debug(`${method} ${url}${body ? ` ${JSON.stringify(body)}` : ''}`);

		let response;
		try {
			response = await fetch(url, {
				method,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
		} catch (error) {
			// server not reachable (network error, refused, timeout, TLS error, ...)
			await this.setConnected(false);
			const cause = error.cause && error.cause.message ? ` (${error.cause.message})` : '';
			if (error.name === 'TimeoutError') {
				throw new Error(`timeout after ${REQUEST_TIMEOUT / 1000} s`);
			}
			throw new Error(`${error.message}${cause}`);
		}

		const text = await response.text();
		if (!response.ok) {
			// server answered, but the request failed (e.g. robot offline) -> connection state unchanged
			throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`invalid JSON response: ${text.substring(0, 200)}`);
		}
		await this.setConnected(true);
		return data;
	}

	/**
	 * Updates vacuula.0.info.connection, which indicates whether the adapter is connected to the Vacuula server.
	 * Only writes the state if the value actually changes.
	 *
	 * @param {boolean} connected - true if the server is reachable and answers correctly
	 */
	async setConnected(connected) {
		if (this.unloading) {
			return;
		}
		await this.setStateChangedAsync('info.connection', connected, true);
	}

	/**
	 * Logs an error only once until it is cleared again; repetitions go to debug.
	 *
	 * @param {string} key - Error key
	 * @param {string} message - Log message
	 */
	reportError(key, message) {
		if (this.activeErrors.has(key)) {
			this.log.debug(message);
		} else {
			this.activeErrors.add(key);
			this.log.error(message);
		}
	}

	/**
	 * @param {string} key - Error key
	 * @param {string} message - Info message logged if the error was active
	 */
	clearError(key, message) {
		if (this.activeErrors.delete(key)) {
			this.log.info(message);
		}
	}

	/**
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @returns {string} id usable as ioBroker object id
	 */
	toObjectId(robotId) {
		return robotId.replace(this.FORBIDDEN_CHARS, '_').replace(/\./g, '_');
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			this.unloading = true;
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
				this.pollTimer = undefined;
			}
			this.setState('info.connection', false, true);
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new Vacuula(options);
} else {
	// otherwise start the instance directly
	new Vacuula();
}
