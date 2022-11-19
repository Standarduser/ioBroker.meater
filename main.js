'use strict';

const utils = require('@iobroker/adapter-core');
const request = require('request'); //depricated

const meaterUrl = 'https://public-api.cloud.meater.com/v1/devices';
const meaterUrlLogin = 'https://public-api.cloud.meater.com/v1/login';

class Meater extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'meater',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.states = new Array();
		this.path = new Array();
		this.token = '';
		this.statusCode = 0;
		this.expire = 0;
		this.updateTimer = 60;
	}

	async onReady() {
		// Reset the connection indicator during startup
		this.setState('info.connection', false, true);

		// Create states
		await this.setObjectNotExistsAsync('info.token', {
			type: 'state',
			common: {
				name: 'Meater cloud auth token',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('info.userId', {
			type: 'state',
			common: {
				name: 'User ID for Meater cloud',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('rawData', {
			type: 'state',
			common: {
				name: 'Last answer from Meater cloud',
				type: 'string',
				role: 'JSON',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('status', {
			type: 'state',
			common: {
				name: 'Status of cloud last API call',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('statusCode', {
			type: 'state',
			common: {
				name: 'Status of cloud last API call as number',
				type: 'number',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('cookingActive', {
			type: 'state',
			common: {
				name: 'If cooking is active with one or more probes',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
			},
			native: {},
		});
		// Connect to cloud
		await this.login();

		// Get data from cloud
		this.readFromCloud();
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			callback();
		} catch (e) {
			callback();
		}
	}

	// Login
	async login() {
		request.post(
			{
				headers: { 'content-type': 'application/json' },
				url: meaterUrlLogin,
				json: { email: this.config.username, password: this.config.password },
			},
			async (error, response, result) => {
				// Login data is not in JSON formmat
				result = JSON.stringify(result);

				// Log received data
				console.debug('result from login: ' + result);

				// Save into states
				this.setStateAsync('rawData', result, true);

				this.token = JSON.parse(result).data.token;
				this.setStateAsync('info.token', this.token, true);

				this.setStateAsync('info.userId', JSON.parse(result).data.userId, true);
				this.setStateAsync('status', JSON.parse(result).status, true);

				this.statusCode = JSON.parse(result).statusCode;
				this.setStateAsync('statusCode', this.statusCode, true);
				await this.handleStatusCode(this.statusCode);
			},
		);
	}

	// Check and handle status code
	async handleStatusCode(statusCode) {
		switch (statusCode) {
			case 200: // OK
				console.debug('Statuscode 200 --> OK');
				this.setState('info.connection', true, true);
				break;
			case 400: // Bad Request
				console.error('Statuscode 400 --> Bad Request');
				this.setState('info.connection', false, true);
				this.updateTimer = 600; //sec
				break;
			case 401: // Unauthorized
				console.log('Statuscode 401 --> Unauthorized --> login');
				this.setState('info.connection', false, true);
				await this.login();
				break;
			case 404: // Not Found
				console.warn('Statuscode 404 --> Not Found');
				this.setState('info.connection', false, true);
				this.updateTimer = 600; //sec
				break;
			case 429: // Too Many Requests
				console.warn('Statuscode 429 --> Too Many Requests');
				this.updateTimer = 600; //sec
				break;
			case 500: // Internal Server Error
				console.warn('Statuscode 500 --> Internal Server Error');
				this.setState('info.connection', false, true);
				this.updateTimer = 600; //sec
				break;
		}
	}

	// Read data from Meater cloud
	async readFromCloud() {
		request.get(
			{
				headers: { Authorization: 'Bearer ' + this.token, 'Accept-Language': this.config.language },
				url: meaterUrl,
			},
			async (error, response, result) => {
				// Log received data
				console.debug('result from readFromCloud: ' + result);

				// Save states
				this.setStateAsync('rawData', result, true);
				this.setStateAsync('status', JSON.parse(result).status, true);

				this.statusCode = JSON.parse(result).statusCode;
				this.setStateAsync('statusCode', this.statusCode, true);
				await this.handleStatusCode(this.statusCode);

				if (this.statusCode == 200) {
					await this.readDeviceData(JSON.parse(result));
				}

				// If everthing is done run again in ...secons
				setTimeout(() => {
					this.readFromCloud();
				}, this.updateTimer * 1000);
			},
		);
	}

	// Create new device
	async createNewDevice(deviceName) {
		// Create device
		await this.createDeviceAsync(deviceName, {
			name: deviceName,
			role: '',
		});
		// Create state for last update
		await this.createStateAsync(deviceName, '', 'last_update', {
			name: 'date/time of last transmitted value',
			type: 'number',
			role: 'date',
			read: true,
			write: false,
		});
		// Create channel "temperature"
		await this.createChannelAsync(deviceName, 'temperature', {
			name: 'temperature',
			role: '',
		});
		// Create state for internal temperature
		await this.createStateAsync(deviceName, 'temperature', 'internal', {
			name: 'temperature of meat',
			type: 'number',
			unit: this.config.tempUnit,
			role: 'value.temperature',
			read: true,
			write: false,
		});
		// Create state for ambient temperature
		await this.createStateAsync(deviceName, 'temperature', 'ambient', {
			name: 'temperature of ambient',
			type: 'number',
			unit: this.config.tempUnit,
			role: 'value.temperature',
			read: true,
			write: false,
		});
		// Create state for target temperature
		await this.createStateAsync(deviceName, 'temperature', 'target', {
			name: 'target temperature of cook session',
			type: 'number',
			unit: this.config.tempUnit,
			role: 'value.temperature',
			read: true,
			write: false,
		});
		// Create state for peak temperature
		await this.createStateAsync(deviceName, 'temperature', 'peak', {
			name: 'peak temperature of cook session',
			type: 'number',
			unit: this.config.tempUnit,
			role: 'value.temperature.max',
			read: true,
			write: false,
		});
		// Create channel "cook"
		await this.createChannelAsync(deviceName, 'cook', {
			name: 'cook',
			role: '',
		});
		// Create state for cook ID
		await this.createStateAsync(deviceName, 'cook', 'id', {
			name: 'ID of cook session',
			type: 'string',
			role: 'state',
			read: true,
			write: false,
		});
		// Create state for cook name
		await this.createStateAsync(deviceName, 'cook', 'name', {
			name: 'name of selected meat',
			type: 'string',
			role: 'state',
			read: true,
			write: false,
		});
		// Create state for cook state
		await this.createStateAsync(deviceName, 'cook', 'state', {
			name: 'state of cook session',
			type: 'string',
			role: 'state',
			read: true,
			write: false,
		});
		// Create state for elapsed time of cook session
		await this.createStateAsync(deviceName, 'cook', 'time_elapsed', {
			name: 'elapsed time of cook session',
			type: 'number',
			unit: 'sec',
			role: 'value.interval',
			read: true,
			write: false,
		});
		// Create state for remaining time of cook session
		await this.createStateAsync(deviceName, 'cook', 'time_remaining', {
			name: 'remaining time of cook session',
			type: 'number',
			unit: 'sec',
			role: 'value.interval',
			read: true,
			write: false,
		});
	}

	// Read device data
	async readDeviceData(jsonObj) {
		// get exitsing devices
		const devices = [];
		const existingDevices = await this.getDevicesAsync();
		for (const dev in existingDevices) {
			devices.push(existingDevices[dev].common.name);
		}

		// cook states
		let numCooking = 0;

		// Set expire time of values
		if (this.config.clearOldValues) {
			this.expire = 2 * this.updateTimer;
		}

		// data from cloud
		for (const dev in jsonObj.data.devices) {
			const deviceData = jsonObj.data.devices[dev];
			const deviceName = deviceData.id;

			// Check if device allready exists or has to be created
			if (!devices.includes(deviceName)) {
				console.log('creating new device: ' + deviceName);
				await this.createNewDevice(deviceName);
			}

			// cook states
			if (deviceData.cook.state != '') {
				numCooking += 1;
			}

			// save states
			await this.setStateAsync(deviceName + '.last_update', {
				val: deviceData.updated_at,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.temperature.internal', {
				val: deviceData.temperature.internal,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.temperature.ambient', {
				val: deviceData.temperature.ambient,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.temperature.target', {
				val: deviceData.cook.temperature.target,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.temperature.peak', {
				val: deviceData.cook.temperature.peak,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.cook.id', {
				val: deviceData.cook.id,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.cook.name', {
				val: deviceData.cook.name,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.cook.state', {
				val: deviceData.cook.state,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.cook.time_elapsed', {
				val: deviceData.cook.time.elapsed,
				ack: true,
				expire: this.expire,
			});
			await this.setStateAsync(deviceName + '.cook.time_remaining', {
				val: deviceData.cook.time.remaining,
				ack: true,
				expire: this.expire,
			});
		}

		// set updateTimer
		if (numCooking > 0) {
			this.updateTimer = this.config.updateCook;
			this.setStateAsync('cookingActive', true, true);
		} else {
			this.updateTimer = this.config.updateIdle;
			this.setStateAsync('cookingActive', false, true);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Meater(options);
} else {
	// otherwise start the instance directly
	new Meater();
}
