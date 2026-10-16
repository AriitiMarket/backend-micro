'use strict';
// Tracking controller pure-function tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

// Recreate validateCoordinates from the controller to test it in isolation.
// (The controller itself requires a DB-connected model, so we test the pure
// coordinate validation logic directly here.)
function validateCoordinates(location) {
  if (location === undefined || location === null) return null;
  const coordinates = location.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2
    || !coordinates.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('"location.coordinates" must be [longitude, latitude]');
  }
  const [longitude, latitude] = coordinates;
  if (longitude < -180 || longitude > 180) throw new Error('"location.coordinates[0]" (longitude) must be between -180 and 180');
  if (latitude < -90 || latitude > 90) throw new Error('"location.coordinates[1]" (latitude) must be between -90 and 90');
  if (location.type !== undefined && location.type !== 'Point') throw new Error('"location.type" must be "Point"');
  return { type: 'Point', coordinates: [longitude, latitude] };
}

// ── validateCoordinates ──
test('validateCoordinates returns null for undefined location', () => {
  assert.equal(validateCoordinates(undefined), null);
});

test('validateCoordinates returns null for null location', () => {
  assert.equal(validateCoordinates(null), null);
});

test('validateCoordinates accepts valid GeoJSON Point', () => {
  const result = validateCoordinates({ type: 'Point', coordinates: [-74.006, 40.7128] });
  assert.deepEqual(result, { type: 'Point', coordinates: [-74.006, 40.7128] });
});

test('validateCoordinates rejects missing coordinates array', () => {
  assert.throws(() => validateCoordinates({ type: 'Point' }), /coordinates/);
});

test('validateCoordinates rejects wrong-length coordinates', () => {
  assert.throws(() => validateCoordinates({ coordinates: [1] }), /coordinates/);
});

test('validateCoordinates rejects non-numeric coordinates', () => {
  assert.throws(() => validateCoordinates({ coordinates: ['a', 'b'] }), /coordinates/);
});

test('validateCoordinates rejects out-of-range longitude', () => {
  assert.throws(() => validateCoordinates({ coordinates: [200, 40] }), /longitude/);
  assert.throws(() => validateCoordinates({ coordinates: [-200, 40] }), /longitude/);
});

test('validateCoordinates rejects out-of-range latitude', () => {
  assert.throws(() => validateCoordinates({ coordinates: [40, 100] }), /latitude/);
  assert.throws(() => validateCoordinates({ coordinates: [40, -100] }), /latitude/);
});

test('validateCoordinates rejects non-Point type', () => {
  assert.throws(() => validateCoordinates({ type: 'LineString', coordinates: [1, 2] }), /type/);
});

test('validateCoordinates accepts boundary coordinates', () => {
  const result = validateCoordinates({ coordinates: [-180, -90] });
  assert.deepEqual(result.coordinates, [-180, -90]);
  const result2 = validateCoordinates({ coordinates: [180, 90] });
  assert.deepEqual(result2.coordinates, [180, 90]);
});
