'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const utils = require('@iobroker/adapter-core');

/** Timeout for a single HTTP request against the Vacuula server (ms) */
const REQUEST_TIMEOUT = 10000;
/** Lower bound for the polling interval (s) */
const MIN_POLL_INTERVAL = 5;
/** Upper bound for the polling interval (s), same as in admin/jsonConfig.json */
const MAX_POLL_INTERVAL = 3600;

/**
 * States which are filled from the response of the "getRobotState" command.
 * Key = state id relative to the robot device, path = location inside the response.
 *
 * @type {Record<string, {path: string[], common: Partial<ioBroker.StateCommon>}>}
 */
const ROBOT_STATES = {
	'status.modelName': {
		path: ['meta', 'modelName'],
		common: { name: 'Model name', type: 'string', role: 'text', read: true, write: false },
	},
	'status.firmware': {
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
		common: { name: 'Error message', type: 'string', role: 'text', read: true, write: false },
	},
	'status.alert': {
		path: ['alert'],
		common: { name: 'Alert message', type: 'string', role: 'text', read: true, write: false },
	},
	'status.state': {
		path: ['state'],
		common: {
			name: 'State',
			type: 'number',
			role: 'value.state',
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
			role: 'value',
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
	// cleaning parameters as reported by the robot (read only), see CLEANING_PARAMETERS for the writable ones
	'status.category': {
		path: ['cleaning', 'category'],
		common: {
			name: 'Cleaning mode (reported by robot)',
			type: 'number',
			role: 'value',
			states: { 2: 'House', 3: 'Spot', 4: 'Map' },
			read: true,
			write: false,
		},
	},
	'status.mode': {
		path: ['cleaning', 'mode'],
		common: {
			name: 'Power mode (reported by robot)',
			type: 'number',
			role: 'value',
			states: { 1: 'Eco', 2: 'Normal' },
			read: true,
			write: false,
		},
	},
	'status.navigationMode': {
		path: ['cleaning', 'navigationMode'],
		common: {
			name: 'Navigation mode (reported by robot)',
			type: 'number',
			role: 'value',
			states: { 1: 'Normal', 2: 'Extra Care', 3: 'Deep' },
			read: true,
			write: false,
		},
	},
	'status.spotWidth': {
		path: ['cleaning', 'spotWidth'],
		common: {
			name: 'Spot width (reported by robot)',
			type: 'number',
			role: 'value',
			unit: 'cm',
			read: true,
			write: false,
		},
	},
	'status.spotHeight': {
		path: ['cleaning', 'spotHeight'],
		common: {
			name: 'Spot height (reported by robot)',
			type: 'number',
			role: 'value',
			unit: 'cm',
			read: true,
			write: false,
		},
	},
};

/**
 * Writable parameters for "startCleaning" in <robot>.parameters.<key>.
 * "status" names the read-only state in ROBOT_STATES with the value reported by the robot;
 * it is used to fill an empty parameter once.
 *
 * @type {Record<string, {status?: string, common: Partial<ioBroker.StateCommon>}>}
 */
const CLEANING_PARAMETERS = {
	category: {
		status: 'status.category',
		common: {
			name: 'Cleaning mode',
			type: 'number',
			role: 'level',
			states: { 2: 'House', 3: 'Spot', 4: 'Map' },
			read: true,
			write: true,
		},
	},
	mode: {
		status: 'status.mode',
		common: {
			name: 'Power mode',
			type: 'number',
			role: 'level',
			states: { 1: 'Eco', 2: 'Normal' },
			read: true,
			write: true,
		},
	},
	navigationMode: {
		status: 'status.navigationMode',
		common: {
			name: 'Navigation mode',
			type: 'number',
			role: 'level',
			states: { 1: 'Normal', 2: 'Extra Care', 3: 'Deep' },
			read: true,
			write: true,
		},
	},
	spotWidth: {
		status: 'status.spotWidth',
		common: { name: 'Spot width', type: 'number', role: 'level', unit: 'cm', min: 0, read: true, write: true },
	},
	spotHeight: {
		status: 'status.spotHeight',
		common: { name: 'Spot height', type: 'number', role: 'level', unit: 'cm', min: 0, read: true, write: true },
	},
	mapId: {
		common: { name: 'Map ID for map cleaning', type: 'string', role: 'text', read: true, write: true, def: '' },
	},
	boundaryId: {
		common: { name: 'Zone ID for map cleaning', type: 'string', role: 'text', read: true, write: true, def: '' },
	},
};

/**
 * Command buttons. "cmd" is sent as payload, "start" builds its parameters from the cleaning parameters.
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

/**
 * Boundary (blocking line / zone) of a map as delivered by the server. Unknown fields are kept and sent back unchanged.
 *
 * @typedef {{id: string, type: string, name?: string, color?: string, enabled?: boolean, [key: string]: unknown}} Boundary
 */

/** Category value for spot cleaning – only then spotWidth/spotHeight are sent */
const CATEGORY_SPOT = 3;
/** Category value for map cleaning – only then mapId/boundaryId are sent */
const CATEGORY_MAP = 4;

/**
 * Boundary types of a map and the folder they are stored in.
 *
 * @type {Record<string, {folder: string, name: string, writable: boolean}>}
 */
const BOUNDARY_TYPES = {
	polyline: { folder: 'blockingline', name: 'Blocking lines', writable: true },
	polygon: { folder: 'zone', name: 'Zones', writable: false },
};

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
		/** Last object definition written per object id, avoids rewriting unchanged objects on every poll */
		/** @type {Map<string, string>} */
		this.objectCache = new Map();
		/** Per map promise chain, serializes read-modify-write of map boundaries */
		/** @type {Map<string, Promise<void>>} */
		this.mapQueues = new Map();
		/** Validated cleaning parameters per robot object id, used for "startCleaning" */
		/** @type {Map<string, Record<string, number | string>>} */
		this.cleaningParameters = new Map();
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
		} else if (interval > MAX_POLL_INTERVAL) {
			this.log.warn(
				`Polling interval of ${interval} s is too long, using maximum of ${MAX_POLL_INTERVAL} seconds`,
			);
			interval = MAX_POLL_INTERVAL;
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
		this.subscribeStates('*.parameters.*');
		this.subscribeStates('*.maps.*.enabled');

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
				await this.updateMaps(objId, robotId);
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

			await this.setState(`${objId}.${stateId}`, { val: value, ack: true });
		}

		await this.seedCleaningParameters(objId, data);
		await this.setState(`${objId}.lastUpdate`, { val: Date.now(), ack: true });
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
		await this.extendObject(`${objId}.lastUpdate`, {
			type: 'state',
			common: {
				name: 'Last update of robot state',
				type: 'number',
				role: 'value.time',
				read: true,
				write: false,
			},
			native: {},
		});

		const channels = {
			status: 'Status',
			parameters: 'Cleaning parameters',
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

		for (const [key, def] of Object.entries(CLEANING_PARAMETERS)) {
			await this.extendObject(`${objId}.parameters.${key}`, {
				type: 'state',
				common: /** @type {ioBroker.StateCommon} */ (def.common),
				native: {},
			});
		}
		await this.loadCleaningParameters(objId);

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
	 * Loads all maps of a robot including their boundaries into vacuula.0.<robot>.maps.<map>.
	 * Maps and boundaries which are no longer reported by the server are kept (never deleted).
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {string} robotId - Robot id on the Vacuula server
	 */
	async updateMaps(objId, robotId) {
		const errorKey = `maps:${robotId}`;
		/** @type {Array<{id: string, name?: string, enabled?: boolean}>} */
		let maps;
		try {
			const data = await this.request('GET', `/api/robot/${encodeURIComponent(robotId)}/maps`);
			if (!Array.isArray(data)) {
				throw new Error(`unexpected response: ${JSON.stringify(data)}`);
			}
			maps = data.filter(map => map && typeof map.id === 'string' && map.id);
		} catch (error) {
			this.reportError(errorKey, `Cannot load maps of robot ${robotId}: ${error.message}`);
			return;
		}
		this.clearError(errorKey, `Maps of robot ${robotId} available again`);

		try {
			await this.ensureObject(`${objId}.maps`, { type: 'folder', common: { name: 'Maps' }, native: {} });

			// Maps/boundaries no longer reported by the server are never deleted; the user removes them manually.
			for (const map of maps) {
				const mapObjId = this.toObjectId(map.id);
				const mapPath = `${objId}.maps.${mapObjId}`;
				const name = map.name ? String(map.name) : map.id;

				await this.ensureObject(mapPath, { type: 'folder', common: { name }, native: { mapId: map.id } });
				await this.ensureObject(`${mapPath}.id`, {
					type: 'state',
					common: { name: 'ID', type: 'string', role: 'text', read: true, write: false },
					native: {},
				});
				await this.ensureObject(`${mapPath}.name`, {
					type: 'state',
					common: { name: 'Name', type: 'string', role: 'text', read: true, write: false },
					native: {},
				});
				await this.ensureObject(`${mapPath}.enabled`, {
					type: 'state',
					common: { name: 'Enabled', type: 'boolean', role: 'indicator', read: true, write: false },
					native: {},
				});
				await this.updateState(`${mapPath}.id`, map.id);
				await this.updateState(`${mapPath}.name`, name);
				await this.updateState(`${mapPath}.enabled`, !!map.enabled);

				// boundaries of disabled maps are not loaded
				if (map.enabled) {
					await this.updateMapBoundaries(objId, robotId, mapObjId, map.id);
				}
			}
		} catch (error) {
			this.log.error(`Cannot create/update map objects for robot ${robotId}: ${error.message}`);
		}
	}

	/**
	 * Loads the boundaries (blocking lines and zones) of one map and writes them into the states.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @param {string} mapObjId - Object id of the map
	 * @param {string} mapId - Map id on the Vacuula server
	 */
	async updateMapBoundaries(objId, robotId, mapObjId, mapId) {
		const errorKey = `boundaries:${robotId}:${mapId}`;
		let boundaries;
		try {
			boundaries = await this.fetchMapBoundaries(robotId, mapId);
		} catch (error) {
			this.reportError(
				errorKey,
				`Cannot load boundaries of map "${mapId}" of robot ${robotId}: ${error.message}`,
			);
			return;
		}
		this.clearError(errorKey, `Boundaries of map "${mapId}" of robot ${robotId} available again`);
		await this.writeMapBoundaries(objId, mapObjId, mapId, boundaries);
	}

	/**
	 * Requests the boundaries of a map via "getMapBoundaries".
	 *
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @param {string} mapId - Map id on the Vacuula server
	 * @returns {Promise<Array<Boundary>>} boundaries exactly as delivered by the server
	 */
	async fetchMapBoundaries(robotId, mapId) {
		const response = await this.sendCommand(robotId, { cmd: 'getMapBoundaries', params: { mapId } });
		const boundaries = response && response.data && response.data.boundaries;
		if (!Array.isArray(boundaries)) {
			throw new Error(`unexpected response: ${JSON.stringify(response)}`);
		}
		return boundaries;
	}

	/**
	 * Creates/updates the objects and states for the boundaries of one map.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {string} mapObjId - Object id of the map
	 * @param {string} mapId - Map id on the Vacuula server
	 * @param {Array<Boundary>} boundaries - Boundaries as delivered by the server
	 */
	async writeMapBoundaries(objId, mapObjId, mapId, boundaries) {
		const mapPath = `${objId}.maps.${mapObjId}`;

		for (const [type, def] of Object.entries(BOUNDARY_TYPES)) {
			const list = boundaries.filter(b => b && b.type === type && typeof b.id === 'string' && b.id);
			if (!list.length) {
				continue;
			}
			await this.ensureObject(`${mapPath}.${def.folder}`, {
				type: 'folder',
				common: { name: def.name },
				native: {},
			});

			for (const boundary of list) {
				const path = `${mapPath}.${def.folder}.${this.toObjectId(boundary.id)}`;

				await this.ensureObject(path, {
					type: 'channel',
					common: { name: boundary.name ? String(boundary.name) : boundary.id },
					native: { mapId, boundaryId: boundary.id, type },
				});
				await this.ensureObject(`${path}.id`, {
					type: 'state',
					common: { name: 'ID', type: 'string', role: 'text', read: true, write: false },
					native: {},
				});
				await this.ensureObject(`${path}.color`, {
					type: 'state',
					common: { name: 'Color', type: 'string', role: 'text', read: true, write: false },
					native: {},
				});
				await this.ensureObject(`${path}.enabled`, {
					type: 'state',
					common: {
						name: 'Enabled',
						type: 'boolean',
						role: def.writable ? 'switch.enable' : 'indicator',
						read: true,
						write: def.writable,
					},
					native: {},
				});

				await this.updateState(`${path}.id`, boundary.id);
				await this.updateState(`${path}.color`, boundary.color == null ? '' : String(boundary.color));
				await this.updateState(`${path}.enabled`, !!boundary.enabled);
			}
		}

		const unknown = boundaries.filter(b => !b || !BOUNDARY_TYPES[b.type]);
		if (unknown.length) {
			this.log.debug(`Ignoring boundaries of unknown type on map "${mapId}": ${JSON.stringify(unknown)}`);
		}
	}

	/**
	 * Changes "enabled" of one boundary: reloads the boundaries of the map, modifies the
	 * boundary and sends the complete list back via "setMapBoundaries".
	 *
	 * @param {string} id - Full id of the changed enabled state
	 * @param {string} objId - Object id of the robot device
	 * @param {string} boundaryPath - Object id of the boundary channel (without namespace)
	 * @param {boolean} enabled - New value
	 */
	async setBoundaryEnabled(id, objId, boundaryPath, enabled) {
		const robotId = this.robots.get(objId);
		const channel = await this.getObjectAsync(boundaryPath);
		const mapId = channel && channel.native && channel.native.mapId;
		const boundaryId = channel && channel.native && channel.native.boundaryId;
		if (!robotId || !mapId || !boundaryId) {
			this.log.warn(`Cannot change ${id}: unknown robot, map or boundary`);
			return;
		}
		if (!this.baseUrl) {
			this.log.error(`Cannot change ${id}: no Vacuula server configured`);
			return;
		}

		await this.runExclusive(`${robotId}|${mapId}`, async () => {
			const mapObjId = boundaryPath.split('.')[2];
			/** @type {boolean | undefined} */
			let previous;
			try {
				const boundaries = await this.fetchMapBoundaries(robotId, mapId);
				const boundary = boundaries.find(b => b && b.id === boundaryId);
				if (!boundary) {
					throw new Error(`boundary ${boundaryId} not found on map "${mapId}"`);
				}
				previous = !!boundary.enabled;
				boundary.enabled = enabled;
				this.addRelevancy(boundaries);

				const payload = { cmd: 'setMapBoundaries', params: { mapId, boundaries } };
				this.log.info(
					`Setting "${boundary.name || boundaryId}" on map "${mapId}" of robot ${robotId} to enabled=${enabled}`,
				);
				this.log.debug(`setMapBoundaries payload: ${JSON.stringify(payload)}`);
				await this.sendCommand(robotId, payload);

				await this.setState(id, enabled, true);
				await this.writeMapBoundaries(objId, mapObjId, mapId, boundaries);
			} catch (error) {
				this.log.error(`Cannot change ${id} to ${enabled}: ${error.message}`);
				if (previous !== undefined) {
					await this.setState(id, previous, true);
				} else {
					await this.updateMapBoundaries(objId, robotId, mapObjId, mapId);
				}
			}
		});
	}

	/**
	 * "setMapBoundaries" expects a "relevancy" point (centroid = mean of all vertices) for every zone,
	 * which "getMapBoundaries" does not deliver. Adds it to all polygons that do not have one yet.
	 *
	 * @param {Array<Boundary>} boundaries - Boundaries, modified in place
	 */
	addRelevancy(boundaries) {
		for (const boundary of boundaries) {
			if (!boundary || boundary.type !== 'polygon' || Array.isArray(boundary.relevancy)) {
				continue;
			}
			const vertices = Array.isArray(boundary.vertices)
				? boundary.vertices.filter(
						v => Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1])),
					)
				: [];
			if (!vertices.length) {
				continue;
			}
			const sum = vertices.reduce((acc, v) => [acc[0] + Number(v[0]), acc[1] + Number(v[1])], [0, 0]);
			boundary.relevancy = [sum[0] / vertices.length, sum[1] / vertices.length];
		}
	}

	/**
	 * Runs tasks with the same key one after another.
	 *
	 * @param {string} key - Serialization key
	 * @param {() => Promise<void>} task - Task to run
	 */
	async runExclusive(key, task) {
		const previous = this.mapQueues.get(key) || Promise.resolve();
		const current = previous.then(task, task);
		this.mapQueues.set(key, current);
		try {
			await current;
		} finally {
			if (this.mapQueues.get(key) === current) {
				this.mapQueues.delete(key);
			}
		}
	}

	/**
	 * Creates or updates an object, but only writes it if its definition changed since the last call.
	 *
	 * @param {string} id - Object id (without namespace)
	 * @param {ioBroker.PartialObject} obj - Object definition
	 */
	async ensureObject(id, obj) {
		const signature = JSON.stringify(obj);
		if (this.objectCache.get(id) === signature) {
			return;
		}
		await this.extendObject(id, obj);
		this.objectCache.set(id, signature);
	}

	/**
	 * Writes a state with ack=true if its value differs or it is not yet acknowledged.
	 *
	 * @param {string} id - State id (without namespace)
	 * @param {ioBroker.StateValue} val - Value
	 */
	async updateState(id, val) {
		const current = await this.getStateAsync(id);
		if (!current || current.val !== val || !current.ack) {
			await this.setState(id, { val, ack: true });
		}
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}

		const parts = id.substring(this.namespace.length + 1).split('.');

		// <namespace>.<objId>.maps.<map>.<blockingline|zone>.<boundary>.enabled
		if (
			parts.length === 6 &&
			parts[1] === 'maps' &&
			parts[5] === 'enabled' &&
			Object.values(BOUNDARY_TYPES).some(def => def.writable && def.folder === parts[3])
		) {
			await this.setBoundaryEnabled(id, parts[0], parts.slice(0, 5).join('.'), !!state.val);
			return;
		}

		// <namespace>.<objId>.parameters.<key>
		if (parts.length === 3 && parts[1] === 'parameters' && CLEANING_PARAMETERS[parts[2]]) {
			await this.setCleaningParameter(id, parts[0], parts[2], state.val);
			return;
		}

		if (!state.val) {
			return;
		}

		// <namespace>.<objId>.commands.<command>
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
			/** @type {{cmd: string, params?: Record<string, number | string>}} */
			const payload = { cmd: def.cmd };
			if (command === 'start') {
				payload.params = this.buildStartParams(objId);
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
	 * Validates and normalises a value for a cleaning parameter.
	 *
	 * @param {string} key - Key in CLEANING_PARAMETERS
	 * @param {ioBroker.StateValue | undefined} raw - Value to check
	 * @returns {number | string | undefined} normalised value, undefined if not set or invalid
	 */
	normalizeCleaningParameter(key, raw) {
		const common = CLEANING_PARAMETERS[key].common;
		if (common.type === 'string') {
			return raw == null ? '' : String(raw).trim();
		}
		if (raw == null || raw === '' || typeof raw === 'boolean') {
			return undefined;
		}
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			return undefined;
		}
		if (common.states && typeof common.states === 'object' && !(String(value) in common.states)) {
			return undefined;
		}
		if (typeof common.min === 'number' && value < common.min) {
			return undefined;
		}
		return value;
	}

	/**
	 * Reads the cleaning parameters of a robot from its states into the internal store.
	 *
	 * @param {string} objId - Object id of the robot device
	 */
	async loadCleaningParameters(objId) {
		/** @type {Record<string, number | string>} */
		const params = {};
		for (const key of Object.keys(CLEANING_PARAMETERS)) {
			const id = `${objId}.parameters.${key}`;
			const state = await this.getStateAsync(id);
			const value = this.normalizeCleaningParameter(key, state ? state.val : null);
			if (value === undefined) {
				if (state && !state.ack) {
					this.log.warn(`Invalid value "${state.val}" for ${id}, ignoring it`);
					await this.setState(id, { val: null, ack: true });
				}
				continue;
			}
			params[key] = value;
			if (!state || !state.ack || state.val !== value) {
				await this.setState(id, { val: value, ack: true });
			}
		}
		this.cleaningParameters.set(objId, params);
	}

	/**
	 * Fills cleaning parameters that have no value yet with the values reported by the robot.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {object} data - Response of "getRobotState"
	 */
	async seedCleaningParameters(objId, data) {
		const params = this.cleaningParameters.get(objId);
		if (!params) {
			return;
		}
		for (const [key, def] of Object.entries(CLEANING_PARAMETERS)) {
			if (!def.status || params[key] !== undefined) {
				continue;
			}
			const raw = ROBOT_STATES[def.status].path.reduce((obj, k) => (obj == null ? undefined : obj[k]), data);
			const value = this.normalizeCleaningParameter(key, raw);
			if (value !== undefined) {
				params[key] = value;
				await this.setState(`${objId}.parameters.${key}`, { val: value, ack: true });
				this.log.debug(`Cleaning parameter ${key} of ${objId} initialised with ${value} reported by the robot`);
			}
		}
	}

	/**
	 * Handles a write to <robot>.parameters.<key>: validates the value, stores it for the next
	 * start and acknowledges the state. Invalid values are rejected and the previous value is restored.
	 *
	 * @param {string} id - Full id of the changed state
	 * @param {string} objId - Object id of the robot device
	 * @param {string} key - Key in CLEANING_PARAMETERS
	 * @param {ioBroker.StateValue} val - Written value
	 */
	async setCleaningParameter(id, objId, key, val) {
		let params = this.cleaningParameters.get(objId);
		if (!params) {
			params = {};
			this.cleaningParameters.set(objId, params);
		}
		const value = this.normalizeCleaningParameter(key, val);
		if (value === undefined) {
			const previous = params[key] === undefined ? null : params[key];
			this.log.warn(`Invalid value "${val}" for ${id}, keeping ${previous === null ? 'no value' : previous}`);
			await this.setState(id, { val: previous, ack: true });
			return;
		}
		params[key] = value;
		this.log.debug(`Cleaning parameter ${key} of ${objId} set to ${JSON.stringify(value)}`);
		await this.setState(id, { val: value, ack: true });
	}

	/**
	 * Builds the "startCleaning" parameters from the stored cleaning parameters of a robot.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @returns {Record<string, number | string>} parameters for the start command
	 */
	buildStartParams(objId) {
		const stored = this.cleaningParameters.get(objId) || {};
		/** @param {string} key - Parameter key */
		const get = key => {
			if (stored[key] === undefined) {
				throw new Error(`parameters.${key} has no valid value`);
			}
			return stored[key];
		};

		/** @type {Record<string, number | string>} */
		const params = {
			category: get('category'),
			mode: get('mode'),
			navigationMode: get('navigationMode'),
		};
		if (params.category === CATEGORY_SPOT) {
			params.spotHeight = get('spotHeight');
			params.spotWidth = get('spotWidth');
		}
		if (params.category === CATEGORY_MAP) {
			// both optional: without mapId the robot uses its current map, without boundaryId the whole map is cleaned
			const mapId = String(stored.mapId || '');
			const boundaryId = String(stored.boundaryId || '');
			if (boundaryId && !mapId) {
				throw new Error('parameters.boundaryId is set, but parameters.mapId is empty');
			}
			if (mapId) {
				params.mapId = mapId;
			}
			if (boundaryId) {
				params.boundaryId = boundaryId;
			}
		}
		return params;
	}

	/**
	 * Sends a command to a robot and checks the result.
	 *
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @param {object} payload - Command payload
	 * @returns {Promise<object>} the parsed response
	 */
	async sendCommand(robotId, payload) {
		const data = await this.request('POST', `/api/robot/${encodeURIComponent(robotId)}/command`, payload);
		if (!data || typeof data !== 'object') {
			throw new Error(`unexpected response: ${JSON.stringify(data)}`);
		}
		if (data.result !== undefined && data.result !== 'ok') {
			throw new Error(
				data.error
					? `robot answered "${data.result}" (${JSON.stringify(data.error)})`
					: `robot answered "${data.result}"`,
			);
		}
		return data;
	}

	/**
	 * Performs a HTTP request against the Vacuula server and returns the parsed JSON body.
	 *
	 * @param {'GET' | 'POST'} method - HTTP method
	 * @param {string} path - Path starting with "/"
	 * @param {object} [body] - JSON body
	 * @returns {Promise<object>} parsed response
	 */
	async request(method, path, body) {
		const url = `${this.baseUrl}${path}`;
		this.log.debug(body ? `${method} ${url} ${JSON.stringify(body)}` : `${method} ${url}`);

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
			if (error.name === 'TimeoutError') {
				throw new Error(`timeout after ${REQUEST_TIMEOUT / 1000} s`);
			}
			throw new Error(
				error.cause && error.cause.message ? `${error.message} (${error.cause.message})` : error.message,
			);
		}

		const text = await response.text();
		if (!response.ok) {
			// server answered, but the request failed (e.g. robot offline) -> connection state unchanged
			throw new Error(
				text
					? `HTTP ${response.status} ${response.statusText}: ${text}`
					: `HTTP ${response.status} ${response.statusText}`,
			);
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
	 * Object id for robots, maps and boundaries: every character except a-z, A-Z, 0-9, "_" and "-" is replaced by "-".
	 *
	 * @param {string} id - Map or boundary id on the Vacuula server
	 * @returns {string} id usable as ioBroker object id
	 */
	toObjectId(id) {
		return id.replace(/[^a-zA-Z0-9_-]/g, '-');
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
