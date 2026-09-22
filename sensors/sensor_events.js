// sensors/sensor_events.js

import { EventEmitter } from 'events';

/**
 * Alle Sensor-Event-Typen.
 * Identisch mit der Dart-Version in der App.
 */
export const SensorEventType = {
  FRAME: 'frame',
  AUDIO: 'audio',
  LOCATION: 'location',
  MOTION: 'motion',
  BUTTON: 'button',
  GESTURE: 'gesture',
  BATTERY: 'battery',
};

export const SensorSource = {
  PHONE: 'phone',
  GLASSES: 'glasses',
  EXTERNAL: 'external',
};

/**
 * Ein einheitliches Sensor-Event.
 */
export class SensorEvent {
  constructor({ type, source, data, timestamp }) {
    this.type = type;
    this.source = source;
    this.data = data || {};
    this.timestamp = timestamp || Date.now();
  }

  toJSON() {
    return {
      type: this.type,
      source: this.source,
      timestamp: this.timestamp,
      data: this.data,
    };
  }

  static fromJSON(json) {
    return new SensorEvent({
      type: json.type,
      source: json.source,
      data: json.data,
      timestamp: json.timestamp,
    });
  }

  // ==================== FACTORY ====================

  static frame({ imageBase64, width, height, source }) {
    return new SensorEvent({
      type: SensorEventType.FRAME,
      source,
      data: { image_base64: imageBase64, width, height },
    });
  }

  static audio({ pcmBase64, sampleRate = 16000, source }) {
    return new SensorEvent({
      type: SensorEventType.AUDIO,
      source,
      data: { pcm_base64: pcmBase64, sample_rate: sampleRate },
    });
  }

  static location({ lat, lon, accuracy, source }) {
    return new SensorEvent({
      type: SensorEventType.LOCATION,
      source,
      data: { lat, lon, accuracy },
    });
  }

  static motion({ accel, gyro, source }) {
    return new SensorEvent({
      type: SensorEventType.MOTION,
      source,
      data: { accel, gyro },
    });
  }

  static button({ button, action, source }) {
    return new SensorEvent({
      type: SensorEventType.BUTTON,
      source,
      data: { button, action },
    });
  }

  static gesture({ gesture, confidence, source }) {
    return new SensorEvent({
      type: SensorEventType.GESTURE,
      source,
      data: { gesture, confidence },
    });
  }

  static battery({ percent, source }) {
    return new SensorEvent({
      type: SensorEventType.BATTERY,
      source,
      data: { percent },
    });
  }
}

/**
 * Der zentrale Sensor-Bus auf dem Server.
 */
export class SensorBus extends EventEmitter {
  push(event) {
    if (!(event instanceof SensorEvent)) {
      event = SensorEvent.fromJSON(event);
    }
    this.emit('event', event);
  }

  onEvent(handler) {
    this.on('event', handler);
  }
}