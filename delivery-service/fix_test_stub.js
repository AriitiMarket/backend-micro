const fs = require('fs');
let content = fs.readFileSync('src/modules/operations/__tests__/assignmentBatches.test.js', 'utf8');

const target = `const partnersService = {
  async getPartner(id) {
    const p = store.partners.get(String(id));
    if (!p) throw Object.assign(new Error('Partner not found'), { status: 404 });
    return p;
  },
};`;

const replacement = `const eligibilityService = require('../../partners/services/partner-eligibility.service.js');
const partnersService = {
  async getPartner(id) {
    const p = store.partners.get(String(id));
    if (!p) throw Object.assign(new Error('Partner not found'), { status: 404 });
    return p;
  },
  isPartnerEligible: eligibilityService.isPartnerEligible,
  async incrementWorkload(id, wId) {
    const p = await this.getPartner(id);
    const capacity = p.maxActiveAssignments || 3;
    if ((p.activeDeliveries || 0) >= capacity) throw Object.assign(new Error('Capacity exceeded'), { status: 409 });
    p.activeDeliveries = (p.activeDeliveries || 0) + 1;
    return p;
  },
  async decrementWorkload(id, wId) {
    const p = await this.getPartner(id).catch(() => null);
    if (p) p.activeDeliveries = Math.max(0, (p.activeDeliveries || 0) - 1);
    return p;
  },
  async completeDelivery(id, wId) {
    return this.decrementWorkload(id, wId);
  }
};`;

content = content.replace(target, replacement);
fs.writeFileSync('src/modules/operations/__tests__/assignmentBatches.test.js', content);
