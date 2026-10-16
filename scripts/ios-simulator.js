// Print the UDID of this app's iOS simulator: IOS_SIMULATOR (name) on the runtime IOS_RUNTIME selects.
// Creates the simulator on that runtime if it does not exist yet (never deletes or erases one).
//   IOS_RUNTIME   empty = newest installed iOS runtime; "26.5" / "27.0" / "27" = that version.
//   IOS_DEVICE_TYPE  only used when creating: device type name, e.g. "iPhone 17 Pro". Default: the type of a
//                 simulator with the same name on another runtime, else a device type called IOS_SIMULATOR.
// Usage: node scripts/ios-simulator.js   (boot.sh calls it; env.sh sets the defaults)
const { execFileSync } = require('node:child_process');

const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
const list = (what, ...filter) => JSON.parse(simctl('list', what, ...filter, '-j'));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const versionKey = (v) => v.split('.').map((n) => n.padStart(4, '0')).join('.');

const name = process.env.IOS_SIMULATOR || fail('IOS_SIMULATOR is not set (scripts/env.sh).');
const wanted = (process.env.IOS_RUNTIME || '').trim();

const runtimes = list('runtimes', 'available').runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable);
if (runtimes.length === 0) fail('No iOS simulator runtime installed (Xcode > Settings > Components).');
runtimes.sort((a, b) => versionKey(b.version).localeCompare(versionKey(a.version)));
const runtime = wanted
  ? runtimes.find((r) => r.version === wanted || r.version.startsWith(`${wanted}.`) || r.identifier === wanted)
  : runtimes[0];
if (!runtime) {
  fail(`No iOS ${wanted} runtime installed. Installed: ${runtimes.map((r) => r.version).join(', ')}. Set IOS_RUNTIME.`);
}

const devices = list('devices', 'available').devices;
const mine = (devices[runtime.identifier] ?? []).filter((d) => d.name === name);
const found = mine.find((d) => d.state === 'Booted') ?? mine[0];
if (found) {
  console.log(found.udid);
  process.exit(0);
}

const types = list('devicetypes').devicetypes; // no 'available' filter here: it returns an empty list
const typeWanted = process.env.IOS_DEVICE_TYPE;
const sameName = Object.values(devices)
  .flat()
  .find((d) => d.name === name && d.deviceTypeIdentifier);
const type = typeWanted
  ? types.find((t) => t.name === typeWanted || t.identifier === typeWanted)
  : sameName
    ? types.find((t) => t.identifier === sameName.deviceTypeIdentifier)
    : types.find((t) => t.name === name);
if (!type) fail(`Cannot create "${name}": unknown device type. Set IOS_DEVICE_TYPE, e.g. "iPhone 17 Pro".`);
if (!runtime.supportedDeviceTypes.some((t) => t.identifier === type.identifier)) {
  fail(`iOS ${runtime.version} does not support ${type.name}. Set IOS_DEVICE_TYPE or IOS_RUNTIME.`);
}
const udid = simctl('create', name, type.identifier, runtime.identifier).trim();
console.error(`Created simulator "${name}" (${type.name}, iOS ${runtime.version}): ${udid}`);
console.log(udid);
