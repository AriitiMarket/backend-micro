/**
 * Jurisdiction enforcement at the edge.
 *
 * The authorization layer decides *whether* a caller may use a route; this decides
 * *what* they may point it at. An admin whose token carries a jurisdiction
 * (`admin_scope`) must not be able to widen a request beyond it by editing the
 * query string — which was previously unchecked, so any admin could ask for any
 * region/business/shop by id.
 *
 * Rules (deliberately conservative — they can only ever NARROW):
 *   * a level listed in the jurisdiction is enforced: an id outside it is refused;
 *   * a level the token does not mention is left to the service, because the edge
 *     cannot resolve it without the location tree;
 *   * an unscoped request from a jurisdiction of exactly ONE location is pinned to
 *     that location, so "no filter" cannot mean "the whole platform";
 *   * no jurisdiction claim at all (the bootstrap admin) is unrestricted.
 */

/** Query params that carry a hierarchy selection, mapped to their level. */
const LOCATION_PARAMS = ['regionId', 'cityId', 'areaId', 'sectorId', 'locationId'];

/**
 * The ids the token is confined to, or null when unrestricted.
 * @returns {{ locations: string[], businesses: string[], shops: string[] }|null}
 */
function jurisdictionOf(payload) {
  const scope = payload && payload.admin_scope;
  if (!scope || typeof scope !== 'object') return null;
  // `*` is the wildcard for "everywhere" (bootstrap admin scope). A level that
  // contains it is unrestricted: it must neither enforce ids nor pin an
  // unscoped request — otherwise `locationId=*` is injected and the service
  // scopes to a location that matches nothing (all dashboard counts go to 0).
  const pick = (value) => {
    if (!Array.isArray(value)) return [];
    const items = value.map(String).filter(Boolean);
    return items.includes('*') ? [] : items;
  };
  const jurisdiction = {
    locations: pick(scope.locations),
    businesses: pick(scope.businesses),
    shops: pick(scope.shops),
  };
  return jurisdiction.locations.length || jurisdiction.businesses.length || jurisdiction.shops.length
    ? jurisdiction
    : null;
}

function parseQuery(req) {
  const raw = String(req.url || '').split('?')[1] || '';
  return new URLSearchParams(raw);
}

/**
 * @returns {{ ok: true, injectedUrl?: string } | { ok: false, param: string, value: string }}
 */
function checkJurisdiction(req) {
  const jurisdiction = jurisdictionOf(req.token);
  if (!jurisdiction) return { ok: true };

  const query = parseQuery(req);

  // A listed level must contain the requested id.
  if (jurisdiction.locations.length) {
    for (const param of LOCATION_PARAMS) {
      const value = query.get(param);
      if (value && !jurisdiction.locations.includes(value)) {
        return { ok: false, param, value };
      }
    }
  }
  if (jurisdiction.businesses.length) {
    const value = query.get('businessId');
    if (value && !jurisdiction.businesses.includes(value)) {
      return { ok: false, param: 'businessId', value };
    }
  }
  if (jurisdiction.shops.length) {
    const value = query.get('shopId');
    if (value && !jurisdiction.shops.includes(value)) {
      return { ok: false, param: 'shopId', value };
    }
  }

  // Unscoped request with a single-location jurisdiction: pin it, so "everything"
  // cannot silently mean the whole platform.
  const askedForScope = [...LOCATION_PARAMS, 'businessId', 'shopId']
    .some((param) => Boolean(query.get(param)));
  if (!askedForScope && jurisdiction.locations.length === 1) {
    query.set('locationId', jurisdiction.locations[0]);
    const base = String(req.url || '').split('?')[0];
    return { ok: true, injectedUrl: `${base}?${query.toString()}` };
  }

  return { ok: true };
}

module.exports = { checkJurisdiction, jurisdictionOf, LOCATION_PARAMS };
