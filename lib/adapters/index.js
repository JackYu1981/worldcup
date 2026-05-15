/**
 * Adapter registry — register and retrieve data source adapters by name.
 */

import { Adapter500 } from './500.js';

const adapters = new Map();

function register(AdapterClass) {
  const instance = new AdapterClass();
  adapters.set(instance.name, instance);
}

export function getAdapter(name) {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`Unknown adapter: "${name}". Available: ${[...adapters.keys()].join(', ')}`);
  }
  return adapter;
}

export function listAdapters() {
  return [...adapters.keys()];
}

register(Adapter500);
