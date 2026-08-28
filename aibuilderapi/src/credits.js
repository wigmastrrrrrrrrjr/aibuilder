// Shared credit-pool math for teambuild.
//
// A team's pool = (every member's daily free grant) + (every member's lifetime
// interaction earnings). All members draw from the one pool for the day; this is
// the "shared credits based on how much all of them have" rule.

import { store } from './store.js';
import { FREE_DAILY_CREDITS, creditsToUnits, unitsToCredits } from './models.js';
import { getVar } from './env.js';

export const FREE_UNITS = creditsToUnits(FREE_DAILY_CREDITS);

export async function teamPool(tid, day) {
  if (!tid) return null;
  const members = await store.teamMembers(tid);
  if (!members.length) return null;
  const earned = await store.earningsUnitsForNames(members);
  const totalUnits = members.length * FREE_UNITS + earned;
  const usedUnits = await store.creditGet(await store.teamCreditKey(tid), day);
  const leftUnits = Math.max(0, totalUnits - usedUnits);
  return {
    members,
    memberCount: members.length,
    earned,
    totalUnits,
    usedUnits,
    leftUnits,
  };
}

// Available after the daily grant has been consumed: the lifetime earnings
// balance can top the user up for the rest of the day.
export async function personalBalance(user, day) {
  const total = Number(getVar('DAILY_CREDITS')) || FREE_DAILY_CREDITS;
  const totalUnits = creditsToUnits(total);
  const spent = await store.getCredits(user.id, day);
  const earned = await store.earningsUnits(user.name);
  return {
    total,
    totalUnits,
    spent,
    dailyLeftUnits: Math.max(0, totalUnits - spent),
    earned,
    // Spendable left = unused daily grant + interaction earnings.
    leftUnits: Math.max(0, totalUnits - spent) + earned,
    leftCredits: unitsToCredits(Math.max(0, totalUnits - spent) + earned),
    totalCredits: total + unitsToCredits(earned),
  };
}