"use strict";

/**
 * ScripTracker.js
 *
 * ScripTracker is a JavaScript mod player that can play MOD, S3M and XM music in a modern browser using the Audio API.
 *
 * Author:			Maarten Janssen
 * Version:			1.0.0
 * Date:			2013-02-14
 * Last updated:	2015-04-27
 */
function ScripTracker () {
	var _this = this;					// Self reference for private functions.

	var module      = null;				// Module file that is playing.
	var pattern     = null;				// The current pattern being played.
	var orderIndex  = 0;				// Index in the order table of the module.
	var currentRow  = 0;				// Current row in pattern.
	var currentTick = 0;				// Current tick in row.

	var audioContext    = null;			// AudioContext for output.
	var audioSource     = null;			// Source object for audio.
	var audioScriptNode = null;			// Audio processing object.
	var sampleRate      = 0;			// Playback sample rate defined by the audioContext.
	var bufferSize      = 4096			// Size of the audio buffer.
	var bpm             = 0;			// Current BPM.
	var ticksPerRow     = 0;			// Current number of ticks in one row (tempo).
	var samplesPerTick  = 0;			// Number of samples to process for the current tick.
	var sampleCount     = 0;			// Number of samples processed for the current tick.
	var sampleStepping  = 0;			// Base sample step based on 125 / 6. 
	var isPlaying       = false;		// Is the player currently playing?

	var masterVolume     = 1;			// The master volume multiplier.
	var masterVolSlide   = 0;			// Master volume delta per tick.
	var breakPattern     = -1;			// Pattern break row to restart next order.
	var orderJump        = -1;			// Order jump index of next order.
	var rowJump          = -1;			// Row to jump to when looping
	var patternDelay     = 0;			// Pattern delay will keep the player at the current row until 0.
	var patternLoop      = false;		// Do not jump to next order, but repeat current.
	var channelRegisters = [];			// Channel registers containing the player data for each channel.
	for (var i = 0; i < 32; i ++) {
		channelRegisters[i] = new ChannelRegisters;
	}

	var eventHandlers = {
		SONG_LOADED: [],
		PLAY:        [],
		STOP:        [],
		SONG_END:    [],
		NEW_ROW:     [],
		NEW_ORDER:   [],
		INSTRUMENT:  [],
		EFFECT:      []
	};

	if (typeof AudioContext !== "undefined") {
		audioContext    = new AudioContext ();			// Create AudioContext.
	} else if (typeof webkitAudioContext !== "undefined") {
		audioContext = new webkitAudioContext ();		// Create Webkit specific AudioContext.
	} else {
		alert ("No audio context!");
		return;
	}
	
	sampleRate      = audioContext.sampleRate;
	sampleStepping  = Math.round(sampleRate * 0.02) * 3;
	audioSource     = audioContext.createBufferSource ();
	audioScriptNode = audioContext.createScriptProcessor (bufferSize, 1, 2);
	audioScriptNode.onaudioprocess = fillBuffer;
	audioSource.start (0);
	

	/**
	 * Load the given ScripTracker Module object and start playback.
	 *
	 * mod - A ScripTracker Module object generated by any of the loaders (e.g. ModLoader, S3mLoader, XmLoader).
	 */
	this.loadModule = function (mod) {
		module = mod;

		// TODO: This should be part of the MOD loader I guess.
		if (module.type == "mod") {
			for (var i = 0; i < module.channels; i ++) {
				channelRegisters[i].panning.pan = (i % 2 == 0) ? 0.7 : 0.3;
			}
		}

		this.resetPlayback ();
		this.dispatchEvent(ScripTracker.Events.playerReady, this);
	};


	this.load = function (url) {
		var fileExt = url.split ('.').pop ().toLowerCase ();
		var req = new XMLHttpRequest ();
		
		req.onload = function (loadEvent) {
			var data = req.response;
			if (data) {
				data = new Uint8Array(data);
				
				switch (fileExt) {
					case "mod":
						this.loadModule (ModuleLoaders.loadMOD(data));
						break;
					case "s3m":
						this.loadModule (ModuleLoaders.loadS3M(data));
						break;
					case "xm":
						this.loadModule (ModuleLoaders.loadXM(data));
						break;
					default:
						return;
				}
			}
		}.bind (this);
		
		req.open ("get", url, true);
		req.responseType = "arraybuffer";
		req.send ();
	}


	function fillBuffer (audioProcessingEvent) {
		if (!isPlaying) return;

		var outputBuffer = audioProcessingEvent.outputBuffer;
		var samplesL     = outputBuffer.getChannelData (0);
		var samplesR     = outputBuffer.getChannelData (1);

		for (var sIndex = 0; sIndex < outputBuffer.length; sIndex ++) {
			var sampleL = 0;
			var sampleR = 0;

			for (var c = 0; c < module.channels; c ++) {
				var registers = channelRegisters[c];
				
				if (registers.sample.sample) {
					var sample = registers.sample.sample.sample[Math.floor (registers.sample.position)];

					var vEnvelopeValue = registers.volume.envelope.getValue  (registers.envelopePos, registers.noteReleased, 1.0);
					var pEnvelopeValue = registers.panning.envelope.getValue (registers.envelopePos, registers.noteReleased, 0.5);
					var vol = vEnvelopeValue * registers.tremolo.volume * registers.volume.channelVolume; // registers.volume.sampleVolume * 
					var pan = Math.max (0.0, Math.min (registers.panning.pan + ((pEnvelopeValue - 0.5) * ((2 - Math.abs (registers.panning.pan - 2)) / 0.5)), 1.0));
					registers.envelopePos += 1 / samplesPerTick;

					// Normal panning.
					if (!registers.isMuted && !registers.tremor.muted) {
						if (registers.panning.pan <= 1.0) {
							sampleL += sample * (1.0 - pan) * vol;
							sampleR += sample *        pan  * vol;

						// Surround sound.
						} else {
							sampleL += sample * 0.5 * vol;
							sampleR -= sample * 0.5 * vol;
						}
					}

					registers.sample.position += registers.sample.reversed ? -registers.sample.step : registers.sample.step;
					registers.sample.remain   -= Math.abs (registers.sample.step);

					// Loop or stop the sample when we reach its end.
					if (registers.sample.remain <= 0) {
						if (registers.sample.sample.loopType === Module.Sample.SampleLoop.LOOP_FORWARD) {
							registers.sample.position = registers.sample.sample.loopStart  - registers.sample.remain;
							registers.sample.remain   = registers.sample.sample.loopLength + registers.sample.remain;
						} else if (registers.sample.sample.loopType === Module.Sample.SampleLoop.LOOP_PINGPONG) {
							registers.sample.position = Math.max (registers.sample.sample.loopStart, registers.sample.position);
							registers.sample.position = Math.min (registers.sample.sample.loopStart + registers.sample.sample.loopLength - 1, registers.sample.position);
							registers.sample.remain   = registers.sample.sample.loopLength;
							registers.sample.reversed = !registers.sample.reversed;
						} else {
							registers.sample.position = registers.sample.sample.sampleLength - 1;
							registers.sample.step     = 0;
						}
					}
				}
			}

			samplesL[sIndex] = sampleL * masterVolume;
			samplesR[sIndex] = sampleR * masterVolume;

			sampleCount ++;
			if (sampleCount === samplesPerTick) {
				sampleCount = 0;
				currentTick ++;
				if (currentTick === ticksPerRow) {
					processRowEnd ();
				}
				processTick ();
			}
		}
	}


	function processTick () {
		if (currentTick === 0) {
			if (currentRow === 0) {
				_this.dispatchEvent(ScripTracker.Events.order, _this);
			}
			_this.dispatchEvent(ScripTracker.Events.row, _this);
		}

		for (var c = 0; c < module.channels; c ++) {
			var registers   = channelRegisters[c];
			var note        = pattern.note[currentRow][c];
			var instrIndex  = pattern.instrument[currentRow][c];
			var volume      = pattern.volume[currentRow][c];
			var effect      = pattern.effect[currentRow][c];
			var effectParam = pattern.effectParam[currentRow][c];
			
			if (currentTick === 0) {
				
				// Change instrument and retrigger current note.
				if (instrIndex !== 0) {
					registers.instrument = instrIndex;
					_this.dispatchEvent(ScripTracker.Events.instrument, _this, c, registers.instrument, note, effect, effectParam);
					var instrument = module.instruments[instrIndex - 1];
					if (instrument) {
						var sampleKey = instrument.sampleKeyMap[note];
						
						// Set sample and envelope registers.
						if (instrument.samples[sampleKey]) {
							registers.sample.sample       = instrument.samples[sampleKey];				// Set sample based on current note.
							registers.sample.remain       = registers.sample.sample.sampleLength		// Remaining length of this sample.
							registers.volume.sampleVolume = registers.sample.sample.volume;				// Set base sample volume.
						}
						registers.sample.position  = 0;													// Restart sample.
						registers.sample.reversed  = false;												// Reset sample reverse playback.
						registers.volume.envelope  = instrument.volumeEnvelope;							// Get volume envelope.
						registers.panning.envelope = instrument.panningEnvelope;						// Get panning envelope.
						registers.envelopePos      = 0;													// Reset volume envelope.
						registers.noteReleased     = false;												// Reset decay.

						// Set channel panning (for MOD use predefined panning).
						if (module.type !== "mod" && registers.sample.sample) {
							registers.panning.pan = registers.sample.sample.panning;
						}
					
						// Remove sample if it has no data.
						if (registers.sample.sample && registers.sample.sample.sampleLength < 1) {
							registers.sample.sample = null;
						}
					} else {
						registers.sample.sample = null;													// Undefined instrument, so no sample!
					}
				}

				// This row contains a note and we are not doing a slide to note.
				if (note !== 0 && effect !== Effects.TONE_PORTA && effect !== Effects.TONE_PORTA_VOL_SLIDE) {
					// On stop note start the release part of the envelope.
					if (note === 97) {
						registers.note         = note;
						registers.noteReleased = true;													// Start release portion of envelopes.
					} else {
						registers.note = note - 1;

						// Update sample frequency according to new note if we have a sample loaded.
						if (registers.sample.sample !== null) {
							registers.period = 7680 - (note - 26 - registers.sample.sample.basePeriod) * 64 - registers.sample.sample.fineTune / 2;
							var freq = 8363 * Math.pow (2, (4608 - registers.period) / 768);

							registers.sample.position     = 0;											// Restart sample.
							registers.volume.sampleVolume = registers.sample.sample.volume;				// Reset sample volume.
							registers.sample.remain       = registers.sample.sample.sampleLength		// Repeat length of this sample.
							registers.sample.step         = freq / sampleStepping;						// Samples per division.
							registers.sample.reversed     = false;										// Reset sample reverse playback.
							registers.noteDelay           = 0;											// Reset note delay.

							// Dispatch instrument event only if no new instrument was set.
							if (instrIndex === 0) {
								_this.dispatchEvent(ScripTracker.Events.instrument, _this, c, registers.instrument, note, effect,effectParam);
							}
						}
					}
				}

				registers.tremolo.volume = 1.0;															// Reset tremolo on each row.
				registers.tremor.muted = false;															// Reset tremor on each new row.
				if (volume >= 0 && volume <= 64) {														// Change channel volume.
					registers.volume.channelVolume = volume / 64;
				} else if (note < 97 && instrIndex !== 0) {
					registers.volume.channelVolume = registers.volume.sampleVolume;
				}

				if (effect !== Effects.NONE) {
					_this.dispatchEvent(ScripTracker.Events.effect, _this, c, registers.instrument, note, effect, effectParam);
				}
			}

			if (volume > 64) Effects.VOLUME_EFFECT.handler (registers, volume, currentTick, c, _this);
			effect.handler (registers, effectParam, currentTick, c, _this);
		}
	}


	function processRowEnd () {
		// If an order jump is encountered jump to row 1 of the order at the given index.
		if (orderJump !== -1 && !patternLoop) {
			currentRow = -1;
			orderIndex = Math.min (module.songLength - 1, orderJump);
			pattern    = module.patterns[module.orders[orderIndex]];
		}

		// Handle pattern break if there is one.
		if (breakPattern !== -1) {
			currentRow = breakPattern - 1;

			// Only handle pattern break when not looping a pattern.
			if (!patternLoop && orderJump === -1) {
				orderIndex ++;

				// Handle the skip order marker.
				while (module.orders[orderIndex] === 0xFE && orderIndex < module.songLength) {
					orderIndex ++
				}

				// When we reach the end of the song jump back to the restart position.
				if (orderIndex === module.songLength || module.orders[orderIndex] == 0xFF) {
					orderIndex = module.restartPosition;
				}

				pattern = module.patterns[module.orders[orderIndex]];
			}
		}

		// Jump to a particular row in the current pattern;
		if (rowJump !== -1) {
			currentRow = rowJump - 1;
			rowJump = -1;
		}

		// Remain at the current row if pattern delay is active.
		if (patternDelay < 2) {
			orderJump    = -1;
			breakPattern = -1;
			currentTick  = 0;
			patternDelay = 0;
			currentRow ++;
		} else {
			patternDelay --;
		}

		// Stop and reset if we no longer have a pattern to work with.
		if (!pattern) {
			_this.dispatchEvent(ScripTracker.Events.songEnded, _this);
			_this.stop ();
			_this.rewind ();
			_this.resetPlayback ();
			return;
		}

		// When we reach the end of our current pattern jump to the next one.
		if (currentRow === pattern.rows) {
			currentRow = 0;
			if (!patternLoop) orderIndex ++;

			// Handle the skip order marker.
			while (module.orders[orderIndex] === 0xFE && orderIndex < module.songLength) {
				orderIndex ++
			}

			// When we reach the end of the song jump back to the restart position.
			if (orderIndex >= module.songLength || module.orders[orderIndex] === 0xFF) {
				_this.dispatchEvent(ScripTracker.Events.songEnded, _this);
				orderIndex = module.restartPosition;
				_this.resetPlayback ();
			}

			pattern = module.patterns[module.orders[orderIndex]];
		}
	}
	
	
	this.resetPlayback = function () {
		for (var c = 0; c < 32; c ++) {
			channelRegisters[c].reset ();
		}
		
		masterVolume   = 0.9;
		masterVolSlide = 0;
		breakPattern   = -1;
		orderJump      = -1;
		rowJump        = -1;
		patternDelay   = 0;
		
		orderIndex  = 0;
		currentRow  = 0;
		currentTick = 0;
		sampleCount = 0;
		
		pattern = module.patterns[module.orders[orderIndex]];
		
		Effects.SET_TEMPO.handler (channelRegisters[0], module.defaultBPM,   0, 0, this);
		Effects.SET_SPEED.handler (channelRegisters[0], module.defaultTempo, 0, 0, this);
		//processTick ();
	}


	/**
	 * Start playback if player is stopped and a module is loaded.
	 */
	this.play = function () {
		if (!isPlaying && module != null) {
			this.dispatchEvent(ScripTracker.Events.play, this);
			processTick  ();
			
			audioSource.connect (audioScriptNode);
			audioScriptNode.connect (audioContext.destination);
			isPlaying = true;
		}
	};


	this.debug = function () {
		audioSource.stop ();
		var regs = channelRegisters;
		debugger;
	}


	/**
	 * Stop playback after the current row has been processed.
	 */
	this.stop = function () {
		audioScriptNode.disconnect (audioContext.destination);
		audioSource.disconnect (audioScriptNode);
		isPlaying = false;
		this.dispatchEvent(ScripTracker.Events.stop, this);
	};


	/**
	 * Jump to the previous order or restart the current order if we are below row 8.
	 */
	this.prevOrder = function () {
		// Jump to previous order if we are above row 8 and it's safe to do.
		if (orderIndex - 1 >= 0 && module.orders[orderIndex] != 0xFE) {
			orderIndex --;
			pattern = module.patterns[module.orders[orderIndex]];
		}
		
		// Setup registers.
		currentRow  = 0;
		currentTick = 0;
		sampleCount = 0;
		for (var c = 0; c < module.channels; c ++) {
			channelRegisters[c].reset ();
		}
		
		processTick ();
	}


	/**
	 * Jump to the top of the next order.
	 */
	this.nextOrder = function () {
		if (orderIndex < module.orders.length - 1) {
			orderIndex ++;
			pattern = module.patterns[module.orders[orderIndex]];
		}
		
		currentRow  = 0;
		currentTick = 0;
		sampleCount = 0;
		for (var c = 0; c < module.channels; c ++) {
			channelRegisters[c].reset ();
		}
		
		processTick ();
	}


	/**
	 * Restart the current order form row 0.
	 */
	this.restartOrder = function () {
		// Setup registers.
		currentRow  = 0;
		currentTick = 0;
		sampleCount = 0;
		for (var c = 0; c < module.channels; c ++) {
			channelRegisters[c].reset ();
		}
		
		processTick ();
	};


	/**
	 * Restart the current module.
	 */
	this.rewind = function () {
		orderIndex  = 0;
		currentRow  = 0;
		currentTick = 0;

		// Get first pattern if a module is loaded.
		if (module != null) {
			pattern = module.patterns[module.orders[orderIndex]];
		}
	};


	/**
	 * Is the given channel muted?
	 *
	 * channel - Index of the channel to check.
	 */
	this.isMuted = function (channel) {
		return channelRegisters[channel].isMuted;
	}


	/**
	 * Is pattern looping activated?
	 */
	this.isPatternLoop = function () {
		return patternLoop;
	}


	/**
	 * Is the player currently playing?
	 */
	this.isPlaying = function () {
		return isPlaying;
	}


	/**
	 * Set or reset the mute flag of the given channel.
	 * 
	 * channel - Index of the channel to toggle mute.
	 * mute    - Mate state of the given channel.
	 */
	this.setMute = function (channel, mute) {
		channelRegisters[channel].isMuted = mute;
	}


	/**
	 * Set the pattern loop flag.
	 *
	 * loop - Sets or clears the pattern loop.
	 */
	this.setPatternLoop = function (loop) {
		patternLoop = loop;
	}


	/**
	 * Get the name of the currently loaded module.
	 */
	this.getSongName = function () {
		return module.name;
	};


	/**
	 * Get the currently active order number .
	 */
	this.getCurrentOrder = function () {
		return orderIndex + 1;
	};


	/**
	 * Get the index of the currently active pattern.
	 */
	this.getCurrentPattern = function () {
		return module.orders[orderIndex];
	};


	/**
	 * Get the song length as the number of orders.
	 */
	this.getSongLength = function () {
		return module.songLength;
	};


	/**
	 * Get the current BPM of the song.
	 */
	this.getCurrentBPM = function () {
		return bpm;
	};


	/**
	 * Get the current number of ticks per row.
	 */
	this.getCurrentTicks = function () {
		return ticksPerRow;
	};


	/**
	 * Get the currently active row of the pattern.
	 */
	this.getCurrentRow = function () {
		return currentRow;
	};


	/**
	 * Get the number of rows in the current pattern.
	 */
	this.getPatternRows = function () {
		return pattern.rows;
	};


	/**
	 * Get the volume [0.0, 1.0] of the given channel.
	 *
	 * channel - Channel index to get the volume.
	 */
	this.getChannelVolume = function (channel) {
		return channelRegisters[channel].volume.sampleVolume * channelRegisters[channel].volume.channelVolume * masterVolume;
	};


	/**
	 * Get the name of the instrument playing on the given channel. Actually returns the samples name, but this is the 
	 * same as the instrument name.
	 *
	 * channel - Channel index to get instrument name.
	 */
	this.getChannelInstrument = function (channel) {
		var registers = channelRegisters[channel];
		if (registers.sample.sample && registers.sample.step > 0) {
			return registers.sample.sample.name;
		} else {
			return "";
		}
	};


	/**
	 * Get note info text for the given channel and row. e.g. 'C-5 01 .. ...'.
	 *
	 * channel - Channel index
	 * row     - Row number it get info of.
	 */
	this.getNoteInfo = function (channel, row) {
		return pattern.toText (row, channel, module.type);
	};


	/**
	 * Dump player registers and current pattern data to the console for debugging.
	 */
	this.dump = function () {
		console.log (registers);
		console.log (pattern);
	}
	
	this.getSamplesPerTick = function () {
		return samplesPerTick;
	}
	
	this.setSamplesPerTick = function (value) {
		samplesPerTick = value;
	}
	
	this.getBpm = function () {
		return bpm;
	}
	
	this.setBpm = function (value) {
		bpm = value;
	}
	
	this.getTicksPerRow = function () {
		return ticksPerRow;
	}
	
	this.setTicksPerRow = function (ticks) {
		ticksPerRow = ticks;
	}
	
	this.getSampleRate = function () {
		return sampleRate;
	}

	this.getSampleStepping = function () {
		return sampleStepping;
	}
	
	this.getNote = function (channel) {
		return pattern.note[currentRow][channel];
	}
	
	this.getPatternVolume = function (channel) {
		return pattern.volume[currentRow][channel];
	}
	
	this.setBreakPattern = function (value) {
		breakPattern = value;
	}
	
	this.getMasterVolume = function () {
		return masterVolume;
	}
	
	this.setMasterVolume = function (value) {
		masterVolume = value;
	}
	
	this.getMasterVolSlide = function () {
		return masterVolSlide;
	}
	
	this.setMasterVolSlide = function (value) {
		masterVolSlide = value;
	}
	
	this.setRowJump = function (value) {
		rowJump = value;
	}
	
	this.setOrderJump = function (value) {
		orderJump = value;
	};


	this.on = function (event, handler) {
		switch (event) {
			case ScripTracker.Events.instrument:
			case ScripTracker.Events.effect:
				eventHandlers[event].push({
					handler: arguments[2],
					param:   arguments[1]
				});
				break;

			default:
				eventHandlers[event].push(handler);
				break;
		}
	};


	this.off = function(event, handler) {
		var handlers = eventHandlers[event];

		switch (event) {
			case ScripTracker.Events.instrument:
			case ScripTracker.Events.effect:
				for (var i = 0; i < handlers.length; i ++) {
					if (arguments.length === 1 || (handlers[i].handler === arguments[2] && handlers[i].param === arguments[1])) {
						handlers.splice(i, 1);
						i --;
					}
				}
				break;

			default:
				for (var i = 0; i < handlers.length; i ++) {
					if (!handler || handlers[i] === handler) {
						handlers.splice(i, 1);
						i --;
					}
				}
				break;
		}
	};


	this.dispatchEvent = function (event, player, channel, instrument, note, effect, effectParam) {
		var handlers = eventHandlers[event];

		switch (event) {
			case ScripTracker.Events.playerReady:
				for (var i = 0; i < handlers.length; i ++) {
					handlers[i](player, player.getSongName(), player.getSongLength());
				}
				break;

			case ScripTracker.Events.order:
				for (var i = 0; i < handlers.length; i ++) {
					handlers[i](player, player.getCurrentOrder(), player.getSongLength(), player.getCurrentPattern());
				}
				break;

			case ScripTracker.Events.row:
				for (var i = 0; i < handlers.length; i ++) {
					handlers[i](player, player.getCurrentRow(), player.getPatternRows());
				}
				break;

			case ScripTracker.Events.instrument:
				for (var i = 0; i < handlers.length; i ++) {
					if (handlers[i].param === instrument) handlers[i].handler(player, instrument, channel, note, effect, effectParam);
				}
				break;

			case ScripTracker.Events.effect:
				for (var i = 0; i < handlers.length; i ++) {
					if (handlers[i].param === effect) handlers[i].handler(player, effect, effectParam, channel, instrument, note);
				}
				break;

			default:
				for (var i = 0; i < handlers.length; i ++) {
					handlers[i](player);
				}
				break;
		}
	};
}


var ChannelRegisters = function () {
	this.instrument = 0;			// Currently active instrument index.
	this.sample = {
		sample:   null,				// Sample object used on this channel.
		position: 0,				// Sample position.
		step:     0,				// Sample position delta.
		remain:   0,				// Amount af sample data remaining.
		reversed: false				// Sample playback is reversed.
	};
	this.volume = {
		channelVolume: 0,			// Current channel volume.
		sampleVolume:  0,			// Current volume of instrument sample.
		volumeSlide:   0,			// Volume delta per tick.
		envelope:      null,		// Volume envelope function object
	};
	this.panning = {
		pan:         0.5,			// Current panning of this channel.
		panSlide:    0,				// Pannning delta per tick
		envelope:    null,			// Panning envelope function object.
	};
	this.porta = {
		notePeriod: 0,				// Period of note to porta to.
		step:       0				// Note porta delta period on each tick.
	};
	this.vibrato = {
		position:  0,				// Vibrato function position.
		step:      0,				// Vibrato step per tick.
		amplitude: 0				// Vibrato function amplitude.
	};
	this.tremolo = {
		position:  0,				// Tremolo function position.
		step:      0,				// Tremolo step per tick.
		amplitude: 0,				// Tremolo function amplitude.
		volume:    1
	};
	this.tremor = {
		onCount:  0,				// Number of ticks channel produces sound.
		offCount: 0,				// Number of ticks channel is muted.
		muted:    false				// Channel is currently muted by tremor effect.
	}
	this.isMuted      = false;			// Channel is muted.
	this.note         = 0;				// Index of the note being played on this channel.
	this.period       = 0;				// Current period of this channel.
	this.noteDelay    = 0;				// Number of ticks to delay note start.
	this.loopMark     = 0;				// Row to jump back to when looping a pattern section.
	this.loopCount    = 0;				// Loop section counter.
	this.tremorCount  = 0;				// Number of ticks before tremor effect mutes channel.
	this.envelopePos  = 0;				// Panning anv volume envelope positions.
	this.noteReleased = false;			// Note release marker for envelopes.
	
	this.reset = function () {
		this.sample.sample   = null;
		this.sample.position = 0;
		this.sample.step     = 0,
		this.sample.remain   = 0;
		this.sample.reversed = false;
		
		this.volume.channelVolume = 0;
		this.volume.sampleVolume  = 0;
		this.volume.volumeSlide   = 0;
		this.volume.envelope      = null;
		
		this.panning.pan      = 0.5;
		this.panning.panSlide = 0;
		this.panning.envelope = null;
		
		this.porta.notePeriod = 0;
		this.porta.step       = 0;
		
		this.vibrato.position  = 0;
		this.vibrato.step      = 0;
		this.vibrato.amplitude = 0;
		
		this.tremolo.position  = 0;
		this.tremolo.step      = 0;
		this.tremolo.amplitude = 0;
		this.tremolo.volume    = 1;
		
		this.tremor.onCount  = 0;
		this.tremor.offCount = 0;
		this.tremor.muted    = false;
		
		this.isMuted      = false;
		this.tremorMute   = false;
		this.note         = 0;
		this.period       = 0;
		this.noteDelay    = 0;
		this.loopMark     = 0;
		this.loopCount    = 0;
		this.envelopePos  = 0;
		this.noteReleased = false;
	};
};


ScripTracker.Events = {
	playerReady: "SONG_LOADED",
	play:        "PLAY",
	stop:        "STOP",
	songEnded:   "SONG_END",
	row:         "NEW_ROW",
	order:       "NEW_ORDER",
	instrument:  "INSTRUMENT",
	effect:      "EFFECT"
};