'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const utils = require('@iobroker/adapter-core');
const { I18n } = require('./lib/i18n');

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
	'cleaning.category': {
		path: ['cleaning', 'category'],
		common: {
			name: 'Cleaning mode',
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
			name: 'Power mode',
			type: 'number',
			role: 'level.mode.cleanup',
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
			role: 'level',
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
	'cleaning.mapId': {
		path: ['cleaning', 'mapId'],
		common: { name: 'Map ID for map cleaning', type: 'string', role: 'text', read: true, write: true, def: '' },
	},
	'cleaning.boundaryId': {
		path: ['cleaning', 'boundaryId'],
		common: { name: 'Zone ID for map cleaning', type: 'string', role: 'text', read: true, write: true, def: '' },
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
		this.unloading = false;
		/** Translations of the log messages */
		this.i18n = new I18n();

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState('info.connection', false, true);

		try {
			const systemConfig = await this.getForeignObjectAsync('system.config');
			this.i18n.setLanguage(systemConfig && systemConfig.common && systemConfig.common.language);
		} catch {
			// keep English
		}

		const protocol = this.config.protocol === 'https' ? 'https' : 'http';
		const host = (this.config.host || '').trim().replace(/\/+$/, '');
		if (!host) {
			this.log.error(this.t('noServerAddress'));
			return;
		}
		this.baseUrl = `${protocol}://${host}`;

		let interval = Number(this.config.pollInterval);
		if (!Number.isFinite(interval) || interval < MIN_POLL_INTERVAL) {
			this.log.warn(this.t('invalidPollInterval', { value: this.config.pollInterval, min: MIN_POLL_INTERVAL }));
			interval = MIN_POLL_INTERVAL;
		}
		this.pollIntervalMs = interval * 1000;

		this.log.info(this.t('usingServer', { url: this.baseUrl, interval }));

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
			this.log.error(this.t('unexpectedPollError', { reason: error.message }));
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
				throw new Error(this.t('unexpectedResponse', { response: JSON.stringify(robotList) }));
			}
		} catch (error) {
			this.reportError(
				'server',
				this.t('cannotFetchRobotList', { url: `${this.baseUrl}/api/robots`, reason: error.message }),
			);
			// also covers HTTP errors / invalid answers of the robot list, the server is not usable then
			await this.setConnected(false);
			for (const objId of this.robots.keys()) {
				await this.setState(`${objId}.connected`, false, true);
			}
			return;
		}

		this.clearError('server', this.t('serverConnected', { url: this.baseUrl }));

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
				this.log.error(this.t('cannotUpdateRobotObjects', { robotId, reason: error.message }));
				continue;
			}

			if (connected) {
				await this.updateRobotState(objId, robotId);
				await this.updateMaps(objId, robotId);
			} else {
				this.log.debug(this.t('robotNotConnected', { name, robotId }));
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
			this.reportError(errorKey, this.t('cannotQueryRobotState', { robotId, reason: error.message }));
			return;
		}
		this.clearError(errorKey, this.t('robotStateAvailable', { robotId }));

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
	 * Loads all maps of a robot including their boundaries into vacuula.0.<robot>.maps.<map>.
	 * Maps and boundaries which are no longer reported by the server are removed.
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
				throw new Error(this.t('unexpectedResponse', { response: JSON.stringify(data) }));
			}
			maps = data.filter(map => map && typeof map.id === 'string' && map.id);
		} catch (error) {
			this.reportError(errorKey, this.t('cannotLoadMaps', { robotId, reason: error.message }));
			return;
		}
		this.clearError(errorKey, this.t('mapsAvailable', { robotId }));

		try {
			await this.ensureObject(`${objId}.maps`, { type: 'folder', common: { name: 'Maps' }, native: {} });

			/** Map object id -> kept boundary ids ("<folder>.<boundary>"), null if the boundaries could not be loaded */
			/** @type {Map<string, Set<string> | null>} */
			const keep = new Map();
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

				if (map.enabled) {
					keep.set(mapObjId, await this.updateMapBoundaries(objId, robotId, mapObjId, map.id));
				} else {
					// disabled map: boundaries are not loaded, already existing objects are kept
					keep.set(mapObjId, null);
				}
			}

			await this.removeStaleMapObjects(objId, keep);
		} catch (error) {
			this.log.error(this.t('cannotUpdateMapObjects', { robotId, reason: error.message }));
		}
	}

	/**
	 * Loads the boundaries (blocking lines and zones) of one map and writes them into the states.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {string} robotId - Robot id on the Vacuula server
	 * @param {string} mapObjId - Object id of the map
	 * @param {string} mapId - Map id on the Vacuula server
	 * @returns {Promise<Set<string> | null>} ids ("<folder>.<boundary>") of the boundaries, null on error
	 */
	async updateMapBoundaries(objId, robotId, mapObjId, mapId) {
		const errorKey = `boundaries:${robotId}:${mapId}`;
		let boundaries;
		try {
			boundaries = await this.fetchMapBoundaries(robotId, mapId);
		} catch (error) {
			this.reportError(errorKey, this.t('cannotLoadBoundaries', { mapId, robotId, reason: error.message }));
			return null;
		}
		this.clearError(errorKey, this.t('boundariesAvailable', { mapId, robotId }));
		return this.writeMapBoundaries(objId, mapObjId, mapId, boundaries);
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
			throw new Error(this.t('unexpectedResponse', { response: JSON.stringify(response) }));
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
	 * @returns {Promise<Set<string>>} ids ("<folder>.<boundary>") of the written boundaries
	 */
	async writeMapBoundaries(objId, mapObjId, mapId, boundaries) {
		const mapPath = `${objId}.maps.${mapObjId}`;
		const written = new Set();

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
				const boundaryObjId = this.toObjectId(boundary.id);
				const path = `${mapPath}.${def.folder}.${boundaryObjId}`;
				written.add(`${def.folder}.${boundaryObjId}`);

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
			this.log.debug(this.t('ignoringUnknownBoundaries', { mapId, boundaries: JSON.stringify(unknown) }));
		}
		return written;
	}

	/**
	 * Deletes objects of maps/boundaries which are no longer reported by the server.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @param {Map<string, Set<string> | null>} keep - Current maps and their boundaries (null = unknown, keep all)
	 */
	async removeStaleMapObjects(objId, keep) {
		const prefix = `${this.namespace}.${objId}.maps.`;
		const objects = await this.getForeignObjectsAsync(`${prefix}*`);
		/** @type {Set<string>} */
		const stale = new Set();

		for (const fullId of Object.keys(objects)) {
			const parts = fullId.substring(prefix.length).split('.');
			const [mapObjId, folder, boundaryObjId] = parts;
			if (!keep.has(mapObjId)) {
				stale.add(`${objId}.maps.${mapObjId}`);
				continue;
			}
			const boundaries = keep.get(mapObjId);
			if (!boundaries || parts.length < 3) {
				continue;
			}
			if (Object.values(BOUNDARY_TYPES).some(def => def.folder === folder)) {
				if (!boundaries.has(`${folder}.${boundaryObjId}`)) {
					stale.add(`${objId}.maps.${mapObjId}.${folder}.${boundaryObjId}`);
				}
			}
		}

		for (const id of stale) {
			this.log.info(this.t('removingObjects', { id }));
			await this.delObjectAsync(id, { recursive: true });
			for (const cachedId of this.objectCache.keys()) {
				if (cachedId === id || cachedId.startsWith(`${id}.`)) {
					this.objectCache.delete(cachedId);
				}
			}
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
			this.log.warn(this.t('cannotChangeUnknown', { id }));
			return;
		}
		if (!this.baseUrl) {
			this.log.error(this.t('cannotChangeNoServer', { id }));
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
					throw new Error(this.t('boundaryNotFound', { boundaryId, mapId }));
				}
				previous = !!boundary.enabled;
				boundary.enabled = enabled;
				this.addRelevancy(boundaries);

				const payload = { cmd: 'setMapBoundaries', params: { mapId, boundaries } };
				this.log.info(
					this.t('settingBoundary', { name: boundary.name || boundaryId, mapId, robotId, value: enabled }),
				);
				this.log.debug(this.t('setMapBoundariesPayload', { payload: JSON.stringify(payload) }));
				await this.sendCommand(robotId, payload);

				await this.setState(id, enabled, true);
				await this.writeMapBoundaries(objId, mapObjId, mapId, boundaries);
			} catch (error) {
				this.log.error(this.t('cannotChangeBoundary', { id, value: enabled, reason: error.message }));
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
			this.log.warn(this.t('unknownCommand', { command }));
			return;
		}
		if (!robotId) {
			this.log.warn(this.t('unknownRobot', { objId, command }));
			return;
		}
		if (!this.baseUrl) {
			this.log.error(this.t('cannotExecuteNoServer', { command }));
			return;
		}

		try {
			/** @type {{cmd: string, params?: Record<string, number | string>}} */
			const payload = { cmd: def.cmd };
			if (command === 'start') {
				payload.params = await this.buildStartParams(objId);
			}

			this.log.info(this.t('sendingCommand', { cmd: def.cmd, robotId, payload: JSON.stringify(payload) }));
			await this.sendCommand(robotId, payload);
			this.log.debug(this.t('commandAccepted', { cmd: def.cmd, robotId }));

			if (command === 'start') {
				await this.acknowledgeCleaningSettings(objId);
			}
		} catch (error) {
			this.log.error(this.t('commandFailed', { cmd: def.cmd, robotId, reason: error.message }));
		} finally {
			await this.setState(id, false, true);
		}

		// refresh state so availableCommands / cleaning values reflect the new situation
		await this.updateRobotState(objId, robotId);
	}

	/**
	 * Confirms user-set cleaning settings (ack=false) after a successful start, so that polling
	 * shows the values reported by the robot again instead of skipping these states forever.
	 *
	 * @param {string} objId - Object id of the robot device
	 */
	async acknowledgeCleaningSettings(objId) {
		for (const [stateId, def] of Object.entries(ROBOT_STATES)) {
			if (!stateId.startsWith('cleaning.') || !def.common.write) {
				continue;
			}
			const fullId = `${objId}.${stateId}`;
			const current = await this.getStateAsync(fullId);
			if (current && current.ack === false) {
				await this.setState(fullId, { val: current.val, ack: true });
			}
		}
	}

	/**
	 * Reads the cleaning states of a robot and builds the "startCleaning" parameters.
	 *
	 * @param {string} objId - Object id of the robot device
	 * @returns {Promise<Record<string, number | string>>} parameters for the start command
	 */
	async buildStartParams(objId) {
		const keys = ['category', 'mode', 'navigationMode'];
		const category = await this.readNumberState(`${objId}.cleaning.category`);
		if (category === CATEGORY_SPOT) {
			keys.push('spotHeight', 'spotWidth');
		}

		/** @type {Record<string, number | string>} */
		const params = {};
		for (const key of keys) {
			params[key] = await this.readNumberState(`${objId}.cleaning.${key}`);
		}

		if (category === CATEGORY_MAP) {
			// both optional: without mapId the robot uses its current map, without boundaryId the whole map is cleaned
			const mapId = await this.readStringState(`${objId}.cleaning.mapId`);
			const boundaryId = await this.readStringState(`${objId}.cleaning.boundaryId`);
			if (boundaryId && !mapId) {
				throw new Error(this.t('boundaryWithoutMap'));
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
	 * @param {string} id - State id
	 * @returns {Promise<string>} trimmed string value of the state, '' if not set
	 */
	async readStringState(id) {
		const state = await this.getStateAsync(id);
		return state && state.val != null ? String(state.val).trim() : '';
	}

	/**
	 * @param {string} id - State id
	 * @returns {Promise<number>} numeric value of the state
	 */
	async readNumberState(id) {
		const state = await this.getStateAsync(id);
		const value = state ? Number(state.val) : NaN;
		if (state == null || state.val === null || state.val === '' || !Number.isFinite(value)) {
			throw new Error(this.t('noNumericValue', { id }));
		}
		return value;
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
			throw new Error(this.t('unexpectedResponse', { response: JSON.stringify(data) }));
		}
		if (data.result !== undefined && data.result !== 'ok') {
			throw new Error(
				data.error
					? this.t('robotAnsweredWithError', { result: data.result, error: JSON.stringify(data.error) })
					: this.t('robotAnswered', { result: data.result }),
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
		this.log.debug(
			body
				? this.t('requestWithBody', { method, url, body: JSON.stringify(body) })
				: this.t('request', { method, url }),
		);

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
				throw new Error(this.t('timeout', { seconds: REQUEST_TIMEOUT / 1000 }));
			}
			throw new Error(
				error.cause && error.cause.message
					? this.t('networkError', { message: error.message, cause: error.cause.message })
					: error.message,
			);
		}

		const text = await response.text();
		if (!response.ok) {
			// server answered, but the request failed (e.g. robot offline) -> connection state unchanged
			throw new Error(
				text
					? this.t('httpErrorWithBody', {
							status: response.status,
							statusText: response.statusText,
							body: text,
						})
					: this.t('httpError', { status: response.status, statusText: response.statusText }),
			);
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(this.t('invalidJson', { text: text.substring(0, 200) }));
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
	 * Translates a log message, see lib/i18n/<language>.json.
	 *
	 * @param {string} key - Message key
	 * @param {Record<string, unknown>} [params] - Values for the {placeholders}
	 * @returns {string} translated message
	 */
	t(key, params) {
		return this.i18n.t(key, params);
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
			this.log.error(this.t('unloadError', { reason: error.message }));
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
