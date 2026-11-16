'use strict';

const { describe, it, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const mockSession = {
  startTransaction: () => {},
  commitTransaction: () => {},
  abortTransaction: () => {},
  endSession: () => {},
};

if (!mongoose.__mockSessionInstalled) {
  mongoose.__mockSessionInstalled = true;
  const orig = mongoose.startSession.bind(mongoose);
  mongoose.startSession = async function (...args) {
    if (mongoose.connection.readyState === 1) {
      return orig(...args);
    }
    return mockSession;
  };
}

const spies = [];

const jest = {
  clearAllMocks() {
    spies.forEach(s => s.mockRestore && s.mockRestore());
    spies.length = 0;
  },
  spyOn(obj, prop) {
    const orig = obj[prop];
    const calls = [];
    const queue = [];
    let defaultMock;

    const fn = function (...args) {
      calls.push(args);
      if (queue.length > 0) {
        return queue.shift()();
      }
      if (defaultMock) {
        return defaultMock();
      }
      return orig ? orig.apply(this, args) : undefined;
    };
    fn.calls = calls;
    fn.mockResolvedValueOnce = (val) => {
      queue.push(() => Promise.resolve(val));
      return fn;
    };
    fn.mockResolvedValue = (val) => {
      defaultMock = () => Promise.resolve(val);
      return fn;
    };
    fn.mockReturnValueOnce = (val) => {
      queue.push(() => val);
      return fn;
    };
    fn.mockReturnValue = (val) => {
      defaultMock = () => val;
      return fn;
    };
    fn.mockRestore = () => {
      obj[prop] = orig;
    };
    obj[prop] = fn;
    spies.push(fn);
    return fn;
  }
};

function matchArg(actual, expected) {
  if (expected && expected.__isObjectContaining) {
    for (const key of Object.keys(expected.expected)) {
      if (!matchArg(actual[key], expected.expected[key])) return false;
    }
    return true;
  }
  if (expected && expected.__any) return true;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function expect(actual) {
  return {
    toBe(expected) { assert.strictEqual(actual, expected); },
    toEqual(expected) { assert.deepStrictEqual(actual, expected); },
    toBeNull() { assert.strictEqual(actual, null); },
    toBeDefined() { assert.notStrictEqual(actual, undefined); },
    toHaveLength(len) { assert.strictEqual(actual.length, len); },
    toBeCloseTo(expected, precision = 2) {
      const diff = Math.abs(actual - expected);
      const tolerance = precision === 0 ? 1 : Math.pow(10, -precision);
      assert(diff <= tolerance, `Expected ${actual} to be close to ${expected} (diff: ${diff}, tolerance: ${tolerance})`);
    },
    toHaveBeenCalledWith(...expectedArgs) {
      assert(actual.calls && actual.calls.some(call => {
        if (call.length < expectedArgs.length) return false;
        return expectedArgs.every((arg, i) => matchArg(call[i], arg));
      }), `Expected call with ${JSON.stringify(expectedArgs)}, got calls: ${JSON.stringify(actual.calls)}`);
    },
    rejects: {
      toThrow(expectedMsg) {
        return assert.rejects(async () => {
          if (typeof actual === 'function') await actual();
          else await actual;
        }, (err) => {
          if (!expectedMsg) return true;
          return err.message && err.message.includes(expectedMsg);
        });
      }
    }
  };
}

expect.objectContaining = (expected) => ({ __isObjectContaining: true, expected });
expect.any = () => ({ __any: true });

// Expose globals for tests written with Jest/Mocha conventions
global.describe = describe;
global.it = it;
global.beforeAll = before;
global.afterAll = after;
global.beforeEach = beforeEach;
global.afterEach = afterEach;
global.jest = jest;
global.expect = expect;

module.exports = { describe, it, before, beforeEach, afterEach, after, jest, expect };
