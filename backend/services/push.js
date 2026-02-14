// ═══════════════════════════════════════════════════════
// FIDDO — Expo Push Notification Service
// Sends push notifications to clients via Expo Push API
// ═══════════════════════════════════════════════════════

const { pushTokenQueries, endUserQueries } = require('../database');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// ═══════════════════════════════════════════════════════
// SEND PUSH (low-level)
// ═══════════════════════════════════════════════════════

async function sendPush(expoPushTokens, { title, body, data = {} }) {
  if (!expoPushTokens || expoPushTokens.length === 0) return;

  const messages = expoPushTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();

    // Clean up invalid tokens
    if (result.data) {
      result.data.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          console.log(`🗑️ Removing invalid push token: ${expoPushTokens[i].substring(0, 20)}...`);
          pushTokenQueries.deleteByToken.run(expoPushTokens[i]);
        }
      });
    }

    return result;
  } catch (error) {
    console.error('Push notification error:', error.message);
    return null;
  }
}


// ═══════════════════════════════════════════════════════
// HIGH-LEVEL PUSH FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Notify client of new points credited
 * Called from services/points.js after creditPoints()
 */
async function pushPointsCredited(endUserId, merchantName, pointsDelta, newBalance) {
  const endUser = endUserQueries.findById.get(endUserId);
  if (!endUser || !endUser.notif_credit) return;

  const tokens = pushTokenQueries.getByUser.all(endUserId);
  if (tokens.length === 0) return;

  await sendPush(
    tokens.map(t => t.token),
    {
      title: merchantName,
      body: `+${pointsDelta} points ! Solde : ${newBalance} pts`,
      data: { type: 'credit', merchantName, pointsDelta, newBalance },
    }
  );
}

/**
 * Notify client when they can redeem a reward
 * Called from services/points.js when canRedeem becomes true
 */
async function pushRewardAvailable(endUserId, merchantName, rewardDescription) {
  const endUser = endUserQueries.findById.get(endUserId);
  if (!endUser || !endUser.notif_reward) return;

  const tokens = pushTokenQueries.getByUser.all(endUserId);
  if (tokens.length === 0) return;

  await sendPush(
    tokens.map(t => t.token),
    {
      title: `🎁 ${merchantName}`,
      body: `Récompense disponible : ${rewardDescription}`,
      data: { type: 'reward_available', merchantName, rewardDescription },
    }
  );
}

/**
 * Notify client when a reward is redeemed
 */
async function pushRewardRedeemed(endUserId, merchantName, rewardLabel, remainingPoints) {
  const endUser = endUserQueries.findById.get(endUserId);
  if (!endUser || !endUser.notif_reward) return;

  const tokens = pushTokenQueries.getByUser.all(endUserId);
  if (tokens.length === 0) return;

  await sendPush(
    tokens.map(t => t.token),
    {
      title: merchantName,
      body: `🎁 Récompense utilisée : ${rewardLabel}. Solde : ${remainingPoints} pts`,
      data: { type: 'reward_redeemed', merchantName, remainingPoints },
    }
  );
}


module.exports = {
  sendPush,
  pushPointsCredited,
  pushRewardAvailable,
  pushRewardRedeemed,
};
