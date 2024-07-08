'use strict';

const utils = require('@iobroker/adapter-core');
const fetch = require('fetch').fetchUrl;

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
		this.on('stateChange', this.onStateChange.bind(this));
		this.states = new Array();
		this.path = new Array();
		this.token = '';
		this.statusCode = 0;
		this.expire = 0;
		this.updateTimer = 60;
		this.loginFailure = false;
		this.timeoutReadFromCloud = null;
		this.timeoutLogin = null;
	}

	async onReady() {
		// Reset the connection indicator during startup
		this.setState('info.connection', false, true);

		// Subscribe to states
		this.subscribeStates('update');

		// Reset states (just to be safe)
		//await this.setStateAsync('update', { val: false, ack: true });

		// Connect to cloud
		await this.login();
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			if (this.timeoutReadFromCloud) {
				this.clearTimeout(this.timeoutReadFromCloud);
			}
			if (this.timeoutLogin) {
				this.clearTimeout(this.timeoutLogin);
			}
			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (state && !state.ack) {
			// The state was changed
			const idParts = id.split('.');

			try {
				// trigger an update
				if (idParts[2] === 'update' && state.val === true) {
					this.log.debug('Update triggered manually');
					this.readFromCloud();
					//await this.setStateAsync('update', { val: false, ack: true });
				}
			} catch (error) {
				this.log.error(`Got an error on handling state change: ${error}.`);
			}
		}
	}

	// Login
	async login() {
		if (this.config.username == '' || this.config.password == '') {
			this.log.error('Credentials for cloud access missing. Please go to adapter settings.');
		} else {
			this.log.debug('Send login to Meater cloud');
			try {
				fetch(
					meaterUrlLogin,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						payload: JSON.stringify({
							email: this.config.username,
							password: this.config.password,
						}),
					},
					async (error, response, result) => {
						// Error handling
						// Remark:
						// response.status == Statuscode of fetch/webserver
						// result.status == Statuscode of MEATER Cloud API
						if (response && 'status' in response && response.status == 200) {
							// Log received data
							this.log.debug('result from login: ' + result);

							// Save into states
							await this.setStateAsync('rawData', result.toString(), true);

							// Handle status code
							await this.handleStatusCode(JSON.parse(result));
							if (this.statusCode == 200) {
								this.loginFailure = false;
								this.token = JSON.parse(result).data.token;
								await this.setStateAsync('info.token', this.token, true);

								await this.setStateAsync('info.userId', JSON.parse(result).data.userId, true);
								await this.setStateAsync('status', JSON.parse(result).status, true);
								this.readFromCloud();
							} else {
								// If something went wrong...
								this.loginFailure = true;
								// try again in <updateTimer> seconds
								this.timeoutLogin = this.setTimeout(() => {
									this.login();
								}, this.updateTimer * 1000);
							}
						} else {
							this.updateTimer = 600; //sec
							this.log.error(
								`Failed reading data from cloud. This seems to be an error of MEATER Cloud server or missing internet connection. Try again in ${this.updateTimer} seconds.`,
							);
							if (error) {
								this.log.debug('Got following error from server: ' + JSON.stringify(error));
							}
							this.log.debug('Got following response from server: ' + JSON.stringify(response));

							// If something went wrong...
							this.loginFailure = true;
							// try again in <updateTimer> seconds
							this.timeoutLogin = this.setTimeout(() => {
								this.login();
							}, this.updateTimer * 1000);
						}
					},
				);
			} catch (error) {
				this.updateTimer = 600; //sec
				this.log.error(
					`Got an error while logging in: ${error}. This seems to be an unhandled error of the adapter. Try again in ${this.updateTimer} seconds.`,
				);

				// If something went wrong...
				this.loginFailure = true;
				// try again in <updateTimer> seconds
				this.timeoutLogin = this.setTimeout(() => {
					this.login();
				}, this.updateTimer * 1000);
			}
		}
	}

	// Check and handle status code of API response
	async handleStatusCode(jsonObj) {
		this.statusCode = jsonObj.statusCode;
		this.setStateAsync('statusCode', this.statusCode, true);
		switch (this.statusCode) {
			case 200: // OK
				this.log.debug('Statuscode 200 --> OK');
				this.setState('info.connection', true, true);
				break;
			case 400: // Bad Request
				this.updateTimer = 600; //sec
				this.log.warn(`Statuscode 400 --> Bad Request. Try again in ${this.updateTimer} seconds.`);
				this.setState('info.connection', false, true);
				break;
			case 401: // Unauthorized
				this.log.info('Statuscode 401 --> Unauthorized --> login');
				this.setState('info.connection', false, true);
				// If login went wrong raise updateTimer
				if (this.loginFailure) {
					this.updateTimer = 600; //sec
					this.log.error(`Try again in ${this.updateTimer} seconds.`);
					// login is selfcalling
				} else {
					await this.login();
				}
				break;
			case 404: // Not Found
				this.updateTimer = 600; //sec
				this.log.warn(`Statuscode 404 --> Not Found. Try again in ${this.updateTimer} seconds.`);
				this.setState('info.connection', false, true);
				break;
			case 429: // Too Many Requests
				this.updateTimer = 600; //sec
				this.log.warn(`Statuscode 429 --> Too Many Requests. Try again in ${this.updateTimer} seconds.`);
				break;
			case 500: // Internal Server Error
				this.updateTimer = 600; //sec
				this.log.warn(`Statuscode 500 --> Internal Server Error. Try again in ${this.updateTimer} seconds.`);
				this.setState('info.connection', false, true);
				break;
		}
	}

	// Read data from Meater cloud
	async readFromCloud() {
		// clear timeout to prevent loop in case of call from login if last call failed
		if (this.timeoutReadFromCloud) {
			this.clearTimeout(this.timeoutReadFromCloud);
		}
		this.log.debug('fetch data from cloud');
		try {
			fetch(
				meaterUrl,
				{
					headers: { Authorization: 'Bearer ' + this.token, 'Accept-Language': this.config.language },
				},
				async (error, response, result) => {
					// Error handling
					// Remark:
					// response.status == Statuscode of fetch/webserver
					// result.status == Statuscode of MEATER Cloud API
					if (response && 'status' in response && response.status == 200) {
						// Log received data
						this.log.debug('result from readFromCloud: ' + result);

						// Save states
						this.setStateAsync('rawData', result.toString(), true);
						this.setStateAsync('status', JSON.parse(result).status, true);

						await this.handleStatusCode(JSON.parse(result));

						if (this.statusCode == 200) {
							await this.readDeviceData(JSON.parse(result));
						}
					} else {
						this.updateTimer = 600; //sec
						this.log.error(
							`Failed reading data from cloud. This seems to be an error of MEATER Cloud server. Try again in ${this.updateTimer} seconds.`,
						);
						if (error) {
							this.log.debug('got following error from server: ' + JSON.stringify(error));
						}
						this.log.debug('got following response from server: ' + JSON.stringify(response));
					}
				},
			);
		} catch (error) {
			this.updateTimer = 600; //sec
			this.log.error(
				`Got an error while fetching data from cloud: ${error}. This seems to be an unhandled error of the adapter. Try again in ${this.updateTimer} seconds.`,
			);
		}
		// If everthing is done run again in <updateTimer> seconds
		this.timeoutReadFromCloud = this.setTimeout(() => {
			this.readFromCloud();
		}, this.updateTimer * 1000);
	}

	// Create new device
	async createNewDevice(deviceName) {
		// Create device
		await this.setObjectNotExistsAsync(deviceName, {
			type: 'device',
			common: {
				name: deviceName,
				role: '',
			},
			native: {},
		});
		// Create state for last update
		await this.setObjectNotExistsAsync(deviceName + '.last_update', {
			type: 'state',
			common: {
				name: 'date/time of last transmitted value',
				type: 'number',
				role: 'date',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create channel "temperature"
		await this.setObjectNotExistsAsync(deviceName + '.temperature', {
			type: 'channel',
			common: {
				name: 'temperature',
				role: '',
			},
			native: {},
		});
		// Create state for internal temperature
		await this.setObjectNotExistsAsync(deviceName + '.temperature.internal', {
			type: 'state',
			common: {
				name: 'temperature of meat',
				type: 'number',
				unit: this.config.tempUnit,
				role: 'value.temperature',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for ambient temperature
		await this.setObjectNotExistsAsync(deviceName + '.temperature.ambient', {
			type: 'state',
			common: {
				name: 'temperature of ambient',
				type: 'number',
				unit: this.config.tempUnit,
				role: 'value.temperature',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for target temperature
		await this.setObjectNotExistsAsync(deviceName + '.temperature.target', {
			type: 'state',
			common: {
				name: 'target temperature of cook session',
				type: 'number',
				unit: this.config.tempUnit,
				role: 'value.temperature',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for peak temperature
		await this.setObjectNotExistsAsync(deviceName + '.temperature.peak', {
			type: 'state',
			common: {
				name: 'peak temperature of cook session',
				type: 'number',
				unit: this.config.tempUnit,
				role: 'value.temperature.max',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create channel "cook"
		await this.setObjectNotExistsAsync(deviceName + '.cook', {
			type: 'channel',
			common: {
				name: 'cook',
				role: '',
			},
			native: {},
		});
		// Create state for cook ID
		await this.setObjectNotExistsAsync(deviceName + '.cook.id', {
			type: 'state',
			common: {
				name: 'ID of cook session',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for cook name
		await this.setObjectNotExistsAsync(deviceName + '.cook.name', {
			type: 'state',
			common: {
				name: 'name of selected meat',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for cook state
		await this.setObjectNotExistsAsync(deviceName + '.cook.state', {
			type: 'state',
			common: {
				name: 'state of cook session',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for elapsed time of cook session
		await this.setObjectNotExistsAsync(deviceName + '.cook.time_elapsed', {
			type: 'state',
			common: {
				name: 'elapsed time of cook session',
				type: 'number',
				unit: 'sec',
				role: 'value.interval',
				read: true,
				write: false,
			},
			native: {},
		});
		// Create state for remaining time of cook session
		await this.setObjectNotExistsAsync(deviceName + '.cook.time_remaining', {
			type: 'state',
			common: {
				name: 'remaining time of cook session',
				type: 'number',
				unit: 'sec',
				role: 'value.interval',
				read: true,
				write: false,
			},
			native: {},
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

		// check if device data has been sent
		if (jsonObj.data.devices !== 'undefined') {
			this.log.debug('got device data from cloud');

			// data from cloud
			for (const dev in jsonObj.data.devices) {
				const deviceData = jsonObj.data.devices[dev];
				const deviceName = deviceData.id;

				// Check if device allready exists or has to be created
				if (!devices.includes(deviceName)) {
					this.log.info('Found new probe --> creating device: ' + deviceName);
					await this.createNewDevice(deviceName);
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

				// the following values will only appear while cooking is active
				if (
					deviceData.cook !== null &&
					deviceData.cook !== 'undefined' &&
					deviceData.cook !== '' &&
					deviceData.cook.state !== null &&
					deviceData.cook.state !== 'undefined' &&
					deviceData.cook.state !== ''
				) {
					numCooking += 1;

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
			}
		} else {
			this.log.debug('no device data from cloud has been sent');
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
