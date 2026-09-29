// Address controller — thin HTTP layer over address.service.
const addressService = require('../services/addresses.service');
const { ok, created } = require('../utils/response');

async function getAddresses(req, res, next) {
  try {
    const addresses = await addressService.getAllAddresses(req.user.id);
    return ok(res, { addresses });
  } catch (err) {
    return next(err);
  }
}

async function addAddress(req, res, next) {
  try {
    const user = await addressService.addAddress({
      userId: req.user.id,
      addressData: {
        // Legacy fields
        label: req.body.label,
        country: req.body.country,
        city: req.body.city,
        state: req.body.state,
        address1: req.body.address1,
        address2: req.body.address2,
        zipCode: req.body.zipCode,
        addressType: req.body.addressType,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        isDefault: req.body.isDefault === true,
        // Location hierarchy (from Delivery Service)
        regionId: req.body.regionId,
        regionName: req.body.regionName,
        cityId: req.body.cityId,
        cityName: req.body.cityName,
        areaId: req.body.areaId,
        areaName: req.body.areaName,
        sectorId: req.body.sectorId,
        sectorName: req.body.sectorName,
        deliveryZoneId: req.body.deliveryZoneId,
        deliveryZoneName: req.body.deliveryZoneName,
        // Address details
        houseBuilding: req.body.houseBuilding,
        landmark: req.body.landmark,
        description: req.body.description,
        phone: req.body.phone,
      },
    });
    return created(res, { user });
  } catch (err) {
    return next(err);
  }
}

async function updateAddress(req, res, next) {
  try {
    const user = await addressService.updateAddress({
      userId: req.user.id,
      addressId: req.params.id,
      addressData: {
        // Legacy fields
        label: req.body.label,
        country: req.body.country,
        city: req.body.city,
        state: req.body.state,
        address1: req.body.address1,
        address2: req.body.address2,
        zipCode: req.body.zipCode,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        isDefault: req.body.isDefault === true,
        // Location hierarchy
        regionId: req.body.regionId,
        regionName: req.body.regionName,
        cityId: req.body.cityId,
        cityName: req.body.cityName,
        areaId: req.body.areaId,
        areaName: req.body.areaName,
        sectorId: req.body.sectorId,
        sectorName: req.body.sectorName,
        deliveryZoneId: req.body.deliveryZoneId,
        deliveryZoneName: req.body.deliveryZoneName,
        // Address details
        houseBuilding: req.body.houseBuilding,
        landmark: req.body.landmark,
        description: req.body.description,
        phone: req.body.phone,
      },
    });
    return ok(res, { user });
  } catch (err) {
    return next(err);
  }
}

async function deleteAddress(req, res, next) {
  try {
    const user = await addressService.deleteAddress({
      userId: req.user.id,
      addressId: req.params.id,
    });
    return ok(res, { user });
  } catch (err) {
    return next(err);
  }
}

async function setDefaultAddress(req, res, next) {
  try {
    const user = await addressService.setDefaultAddress({
      userId: req.user.id,
      addressId: req.params.id,
    });
    return ok(res, { user });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};