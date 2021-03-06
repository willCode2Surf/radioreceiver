// Copyright 2013 Google Inc. All rights reserved.
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * High-level radio control functions.
 * @constructor
 */
function RadioController() {

  var TUNER = {'vendorId': 0x0bda, 'productId': 0x2838};
  var SAMPLE_RATE = 2048000;
  var BUFS_PER_SEC = 5;
  var SAMPLES_PER_BUF = Math.floor(SAMPLE_RATE / BUFS_PER_SEC);
  var NULL_FUNC = function(){};
  var STATE = {
    OFF: 0,
    STARTING: 1,
    PLAYING: 2,
    STOPPING: 3,
    CHG_FREQ: 4,
    SCANNING: 5
  };
  var SUBSTATE = {
    USB: 1,
    TUNER: 2,
    ALL_ON: 3,
    TUNING: 4,
    PLAYING: 5
  };

  var decoder = new Worker('decode-worker.js');
  var player = new Player();
  var state = new State(STATE.OFF);
  var requestingBlocks = 0;
  var playingBlocks = 0;
  var frequency = 88500000;
  var stereo = true;
  var stereoEnabled = true;
  var errorHandler;
  var tuner;
  var connection;
  var ui;

  /**
   * Starts playing the radio.
   * @param {Function=} opt_callback A function to call when the radio
   *     starts playing.
   */
  function start(opt_callback) {
    if (state.state == STATE.OFF) {
      state = new State(STATE.STARTING, SUBSTATE.USB, opt_callback);
      chrome.permissions.request(
        {'permissions': [{'usbDevices': [TUNER]}]},
        function(res) {
          if (!res) {
            state = new State(STATE.OFF);
            throwError('This app has no permission to access the USB ports.');
          } else {
            processState();
          }
        });
    } else if (state.state == STATE.STOPPING || state.state == STATE.STARTING) {
      state = new State(STATE.STARTING, state.substate, opt_callback);
    }
  }

  /**
   * Stops playing the radio.
   * @param {Function=} opt_callback A function to call after the radio
   *     stops playing.
   */
  function stop(opt_callback) {
    if (state.state == STATE.OFF) {
      opt_callback && opt_callback();
    } else if (state.state == STATE.STARTING || state.state == STATE.STOPPING) {
      state = new State(STATE.STOPPING, state.substate, opt_callback);
    } else if (state.state != STATE.STOPPING) {
      state = new State(STATE.STOPPING, SUBSTATE.ALL_ON, opt_callback);
    }
  }

  /**
   * Tunes to another frequency.
   * @param {number} freq The new frequency in Hz.
   */
  function setFrequency(freq) {
    if (state.state == STATE.PLAYING || state.state == STATE.CHG_FREQ
        || state.state == STATE.SCANNING) {
      state = new State(STATE.CHG_FREQ, null, freq);
    } else {
      frequency = freq;
      ui && ui.update();
    }
  }

  /**
   * Returns the currently tuned frequency.
   * @return {number} The current frequency in Hz.
   */
  function getFrequency() {
    return frequency;
  }

  /**
   * Searches a given frequency band for a station, starting at the
   * current frequency.
   * @param {number} min The minimum frequency, in Hz.
   * @param {number} max The maximum frequency, in Hz.
   * @param {number} step The step between stations, in Hz. The step's sign
   *     determines the scanning direction.
   */
  function scan(min, max, step) {
    if (state.state == STATE.PLAYING || state.state == STATE.SCANNING) {
      var param = {
        min: min,
        max: max,
        step: step,
        start: frequency
      };
      state = new State(STATE.SCANNING, SUBSTATE.TUNING, param);
    }
  }

  /**
   * Returns whether the radio is doing a frequency scan.
   * @return {boolean} Whether the radio is doing a frequency scan.
   */
  function isScanning() {
    return state.state == STATE.SCANNING;
  }

  /**
   * Returns whether the radio is currently playing.
   * @param {boolean} Whether the radio is currently playing.
   */
  function isPlaying() {
    return state.state != STATE.OFF && state.state != STATE.STOPPING;
  }

  /**
   * Returns whether the radio is currently stopping.
   * @param {boolean} Whether the radio is currently stopping.
   */
  function isStopping() {
    return state.state == STATE.STOPPING;
  }

  /**
   * Returns whether a stereo signal is being decoded.
   * @param {boolean} Whether a stereo signal is being decoded.
   */
  function isStereo() {
    return stereo;
  }

  /**
   * Enables or disables stereo decoding.
   * @param {boolean} enable Whether stereo decoding should be enabled.
   */
  function enableStereo(enable) {
    stereoEnabled = enable;
    ui && ui.update();
  }

  /**
   * Returns whether stereo decoding is enabled.
   * @return {boolean} Whether stereo decoding is enabled.
   */
  function isStereoEnabled() {
    return stereoEnabled;
  }

  /**
   * Saves a reference to the current user interface controller.
   * @param {Object} iface The controller. Must have an update() method.
   */
  function setInterface(iface) {
    ui = iface;
  }

  /**
   * Sets a function to be called when there is an error.
   * @param {Function} handler The function to call. Its only parameter
   *      is the error message.
   */
  function setOnError(handler) {
    errorHandler = handler;
  }

  /**
   * Handles an error.
   * @param {string} msg The error message.
   */
  function throwError(msg) {
    if (errorHandler) {
      errorHandler(msg);
    } else {
      throw msg;
    }
  }

  /**
   * Starts the decoding pipeline.
   */
  function startPipeline() {
    // In this way we read one block while we decode and play another.
    if (state.state == STATE.PLAYING) {
      processState();
    }
    processState();
  }

  /**
   * Performs the appropriate action according to the current state.
   */
  function processState() {
    if (state.state == STATE.STARTING) {
      if (state.substate == SUBSTATE.USB) {
        state = new State(STATE.STARTING, SUBSTATE.TUNER, state.param);
        chrome.usb.findDevices(TUNER,
            function(conns) {
              if (conns.length == 0) {
                state = new State(STATE.OFF);
                throwError('USB tuner device not found. The Radio Receiver ' +
                           'app needs an RTL2832U-based DVB-T dongle ' +
                           '(with an R820T tuner chip) to work.');
              } else {
                connection = conns[0];
                processState();
              }
            });
      } else if (state.substate == SUBSTATE.TUNER) {
        state = new State(STATE.STARTING, SUBSTATE.ALL_ON, state.param);
        tuner = new RTL2832U(connection);
        tuner.setOnError(throwError);
        tuner.open(function() {
        tuner.setSampleRate(SAMPLE_RATE, function(rate) {
        tuner.setCenterFrequency(frequency, function() {
        processState();
        })})});
      } else if (state.substate == SUBSTATE.ALL_ON) {
        var cb = state.param;
        state = new State(STATE.PLAYING);
        tuner.resetBuffer(function() {
        cb && cb();
        ui && ui.update();
        startPipeline();
        });
      }
    } else if (state.state == STATE.PLAYING) {
      ++requestingBlocks;
      tuner.readSamples(SAMPLES_PER_BUF, function(data) {
        --requestingBlocks;
        if (state.state == STATE.PLAYING) {
          if (playingBlocks <= 2) {
            ++playingBlocks;
            decoder.postMessage([data, stereoEnabled]);
          }
        }
        processState();
      });
    } else if (state.state == STATE.CHG_FREQ) {
      if (requestingBlocks > 0) {
        return;
      }
      frequency = state.param;
      ui && ui.update();
      tuner.setCenterFrequency(frequency, function() {
      tuner.resetBuffer(function() {
      state = new State(STATE.PLAYING);
      startPipeline();
      })});
    } else if (state.state == STATE.SCANNING) {
      if (requestingBlocks > 0) {
        return;
      }
      var param = state.param;
      if (state.substate == SUBSTATE.TUNING) {
        frequency += param.step;
        if (frequency > param.max) {
          frequency = param.min;
        } else if (frequency < param.min) {
          frequency = param.max;
        }
        ui && ui.update();
        state = new State(STATE.SCANNING, SUBSTATE.PLAYING, param);
        tuner.setCenterFrequency(frequency, function() {
        tuner.resetBuffer(processState);
        });
      } else if (state.substate == SUBSTATE.PLAYING) {
        if (frequency == param.start) {
          state = new State(STATE.PLAYING);
          startPipeline();
          return;
        }
        state = new State(STATE.SCANNING, SUBSTATE.TUNING, param);
        var scanData = {
          'scanning': true,
          'frequency': frequency
        };
        ++requestingBlocks;
        tuner.readSamples(SAMPLES_PER_BUF, function(data) {
          --requestingBlocks;
          if (state.state == STATE.SCANNING) {
            ++playingBlocks;
            decoder.postMessage([data, stereoEnabled, scanData]);
          }
          processState();
        });
      }
    } else if (state.state == STATE.STOPPING) {
      if (state.substate == SUBSTATE.ALL_ON) {
        if (requestingBlocks > 0) {
          return;
        }
        state = new State(STATE.STOPPING, SUBSTATE.TUNER, state.param);
        ui && ui.update();
        tuner.close(function() {
          processState();
        });
      } else if (state.substate == SUBSTATE.TUNER) {
        state = new State(STATE.STOPPING, SUBSTATE.USB, state.param);
        chrome.usb.closeDevice(connection, function() {
          processState();
        });
      } else if (state.substate == SUBSTATE.USB) {
        var cb = state.param;
        state = new State(STATE.OFF);
        cb && cb();
        ui && ui.update();
      }
    }
  }

  /**
   * Receives the sound from the demodulator and plays it.
   * @param {Event} msg The data sent by the demodulator.
   */
  decoder.onmessage = function(msg) {
    --playingBlocks;
    var newStereo = !!msg.data[1];
    if (newStereo != stereo) {
      stereo = newStereo;
      ui && ui.update();
    }
    player.play(msg.data[0], msg.data[1]);
    if (state.state == STATE.SCANNING && msg.data[2] && msg.data[2]['scanning']) {
      if (overload(msg.data[0]) < 0.075) {
        setFrequency(msg.data[2].frequency);
      }
    }
  };

  /**
   * Calculates the proportion of samples above maximum amplitude.
   * @param {Samples} samples The audio stream.
   * @param {number} The proportion of samples above the maximum amplitude.
   */
  function overload(samples) {
    var count = 0;
    for (var i = 0; i < samples.data.length; ++i) {
      if (samples.data[i] > 1 || samples.data[i] < -1) {
        ++count;
      }
    }
    return count / samples.data.length;
  }

  /**
   * Constructs a state object.
   * @param {number} state The state.
   * @param {number=} opt_substate The sub-state.
   * @param {*=} opt_param The state's parameter.
   */
  function State(state, opt_substate, opt_param) {
    return {
      state: state,
      substate: opt_substate,
      param: opt_param
    };
  }

  return {
    start: start,
    stop: stop,
    setFrequency: setFrequency,
    getFrequency: getFrequency,
    scan: scan,
    isScanning: isScanning,
    isPlaying: isPlaying,
    isStopping: isStopping,
    isStereo: isStereo,
    enableStereo: enableStereo,
    isStereoEnabled: isStereoEnabled,
    setInterface: setInterface,
    setOnError: setOnError
  };
}
