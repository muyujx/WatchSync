// ===== 本地 vendor 版说明（基于 @trystero-p2p/nostr 0.25.4 dist/index.mjs）=====
// 上游无公开 API 清除「announce 发送失败退避」状态：满员断开中继后 socket 关闭，
// announce 循环每轮 send 失败会把退避翻倍累计到 15 分钟；之后即使恢复中继重连成功，
// announce 仍会被卡在退避表里长达十几分钟，掉线重连等于失效。
// 故 vendor 此文件，把退避/退役表改为可重置，并导出 resetRelayState 供恢复时调用。
// 另新增 setAnnounceFast：断线重连期间把 announce 节奏从稳态 60s 提到约 3s（见下方常量区）。
// 升级 @trystero-p2p/nostr 时需同步重新 vendor。
import { schnorr } from "@noble/secp256k1";
import { createRelayManager, createTopicStrategy, fromJson, genId, getRelays, hashWith, libName, makeSocket, pauseRelayReconnection, resumeRelayReconnection, selfId, strToNum, toHex, toJson } from "@trystero-p2p/core";
//#region src/index.ts
const relayManager = createRelayManager((client) => client.socket);
const defaultRedundancy = 5;
const tag = "x";
const eventMsgType = "EVENT";
const { secretKey, publicKey } = schnorr.keygen();
const pubkey = toHex(publicKey);
const subIdToTopic = {};
const msgHandlers = {};
const kindCache = {};
const maxTopicsPerSubscription = 250;
const steadyAnnounceIntervalMs = 6e4;
const maxRelayBackoffMs = 15 * 6e4;
const relayAckTimeoutMs = 5333;
// announce 加速间隔（本地 vendor 新增）：断线重连期间以短节奏补发 announce，
// 把「重新发现房主」从稳态 60s 缩到秒级；由 setAnnounceFast 开关
const fastAnnounceIntervalMs = 3e3;
// 加速开关（模块级）：true 期间 publishTopic 的 announce 返回短间隔
let fastAnnounce = false;
/**
 * 开关 announce 加速（本地 vendor 新增）。
 * 场景：成员端心跳超时/房主离开后开启，促进与房主在信令中继上重新发现；
 * 重连成功或放弃重连时必须关闭，否则 announce 会一直以 3s 节奏空转。
 * 参数：on true=加速（约 3s 一轮），false=恢复稳态（60s 一轮）。返回值：无。
 */
export function setAnnounceFast(on) {
	fastAnnounce = on;
}
// 可重置：见文件头说明
let relayBackoffs = /* @__PURE__ */ new WeakMap();
// 可重置：见文件头说明
let retiredRelays = /* @__PURE__ */ new WeakSet();
const pendingAnnouncementAcks = /* @__PURE__ */ new WeakMap();
const backoffRelay = (client) => {
	const previous = relayBackoffs.get(client);
	const delayMs = Math.min(previous?.delayMs ? Math.max(steadyAnnounceIntervalMs, previous.delayMs * 2) : steadyAnnounceIntervalMs, maxRelayBackoffMs);
	relayBackoffs.set(client, {
		delayMs,
		untilMs: Date.now() + delayMs
	});
	return delayMs;
};
const getRelayBackoffMs = (client) => {
	const state = relayBackoffs.get(client);
	if (!state) return 0;
	const remainingMs = state.untilMs - Date.now();
	if (remainingMs > 0) return remainingMs;
	return 0;
};
const nextAnnounce = (nextAnnounceMs) => ({ nextAnnounceMs });
const stopAnnouncing = { stopAnnouncing: true };
const retireRelay = (client) => {
	if (retiredRelays.has(client)) return false;
	const pending = pendingAnnouncementAcks.get(client);
	if (pending) {
		clearTimeout(pending.timer);
		pendingAnnouncementAcks.delete(client);
	}
	retiredRelays.add(client);
	relayBackoffs.delete(client);
	client.close?.();
	return true;
};
const trackAnnouncementAck = (client, eventId) => {
	const pending = pendingAnnouncementAcks.get(client);
	if (pending) {
		clearTimeout(pending.timer);
		pending.eventIds.add(eventId);
	}
	const eventIds = pending?.eventIds ?? /* @__PURE__ */ new Set([eventId]);
	const timer = setTimeout(() => {
		pendingAnnouncementAcks.delete(client);
	}, relayAckTimeoutMs);
	pendingAnnouncementAcks.set(client, {
		eventIds,
		timer
	});
};
const acknowledgeEvent = (client, eventId) => {
	const pending = pendingAnnouncementAcks.get(client);
	if (!pending?.eventIds.has(eventId)) return false;
	clearTimeout(pending.timer);
	pendingAnnouncementAcks.delete(client);
	return true;
};
const now = () => Math.floor(Date.now() / 1e3);
const topicToKind = (topic) => kindCache[topic] ??= strToNum(topic, 1e4) + 2e4;
const createEvent = async (topic, content) => {
	const payload = {
		kind: topicToKind(topic),
		tags: [[tag, topic]],
		created_at: now(),
		content,
		pubkey
	};
	const id = await hashWith("SHA-256", toJson([
		0,
		payload.pubkey,
		payload.created_at,
		payload.kind,
		payload.tags,
		payload.content
	]));
	return toJson([eventMsgType, {
		...payload,
		id: toHex(id),
		sig: toHex(await schnorr.signAsync(id, secretKey))
	}]);
};
const subscribe = (subId, topic) => {
	subIdToTopic[subId] = topic;
	return toJson([
		"REQ",
		subId,
		{
			kinds: [topicToKind(topic)],
			since: now(),
			["#x"]: [topic]
		}
	]);
};
const batchers = {};
const resolveBatchFlush = (batcher) => {
	batcher.flushWaiters.forEach((resolve) => resolve());
	batcher.flushWaiters.clear();
};
const batchAdd = (client, topic, handler) => {
	const batcher = batchers[client.url] ??= {
		subIds: [],
		topics: /* @__PURE__ */ new Map(),
		updateTimer: null,
		flushWaiters: /* @__PURE__ */ new Set()
	};
	batcher.topics.set(topic, handler);
	scheduleBatchFlush(client, batcher);
};
const batchRemove = (client, topic) => {
	const batcher = batchers[client.url];
	if (!batcher) return;
	batcher.topics.delete(topic);
	if (batcher.topics.size === 0) {
		if (batcher.updateTimer !== null) {
			clearTimeout(batcher.updateTimer);
			batcher.updateTimer = null;
		}
		resolveBatchFlush(batcher);
		batcher.subIds.forEach((subId) => client.send(toJson(["CLOSE", subId])));
		delete batchers[client.url];
	} else scheduleBatchFlush(client, batcher);
};
const scheduleBatchFlush = (client, batcher) => {
	if (batcher.updateTimer !== null) return;
	batcher.updateTimer = setTimeout(() => {
		batcher.updateTimer = null;
		try {
			flushBatch(client);
		} finally {
			resolveBatchFlush(batcher);
		}
	}, 0);
};
const waitForBatchFlush = (client) => {
	const batcher = batchers[client.url];
	if (!batcher || batcher.updateTimer === null) return Promise.resolve();
	return new Promise((resolve) => batcher.flushWaiters.add(resolve));
};
const flushBatch = (client) => {
	const batcher = batchers[client.url];
	if (!batcher || batcher.topics.size === 0) return;
	const topics = [...batcher.topics.keys()];
	const chunks = [];
	const since = now();
	for (let i = 0; i < topics.length; i += maxTopicsPerSubscription) chunks.push(topics.slice(i, i + maxTopicsPerSubscription));
	while (batcher.subIds.length > chunks.length) {
		const subId = batcher.subIds.pop();
		if (subId) client.send(toJson(["CLOSE", subId]));
	}
	chunks.forEach((chunk, i) => {
		const subId = batcher.subIds[i] ??= genId(64);
		client.send(toJson([
			"REQ",
			subId,
			{
				kinds: [...new Set(chunk.map(topicToKind))],
				since,
				["#x"]: chunk
			}
		]));
	});
};
const resubscribeOnReconnect = (client) => {
	const batcher = batchers[client.url];
	if (batcher && batcher.topics.size > 0) flushBatch(client);
};
const joinRoom = createTopicStrategy({
	init: (config) => getRelays(config, defaultRelayUrls, defaultRedundancy, true).map((url) => {
		const client = relayManager.register(url, () => makeSocket(url, (data) => {
			const [msgType, subId, payload, relayMsg] = fromJson(data);
			if (msgType !== eventMsgType) {
				const prefix = `${libName}: relay failure from ${client.url} - `;
				const rejectionReason = msgType === "CLOSED" && typeof payload === "string" ? payload : relayMsg;
				const didRejectEvent = msgType === "OK" && payload === false;
				const isRateLimited = didRejectEvent && rejectionReason?.startsWith("rate-limited:");
				const isDuplicate = didRejectEvent && rejectionReason?.startsWith("duplicate:");
				const isTerminalRejection = msgType === "CLOSED" || didRejectEvent && !isRateLimited && !isDuplicate;
				const didAcknowledgeAnnouncement = msgType === "OK" && acknowledgeEvent(client, subId);
				if (isTerminalRejection && !retireRelay(client)) return;
				if (isRateLimited) backoffRelay(client);
				else if (didAcknowledgeAnnouncement) relayBackoffs.delete(client);
				if (!isDuplicate && config.relayConfig?.warnOnRelayFailure !== false) {
					if (msgType === "NOTICE") console.warn(prefix + subId);
					else if (didRejectEvent || msgType === "CLOSED") console.warn(prefix + rejectionReason);
				}
				return;
			}
			if (payload && typeof payload === "object" && "content" in payload) {
				const { content } = payload;
				const handler = msgHandlers[subId];
				if (handler) {
					handler(subIdToTopic[subId] ?? "", content);
					return;
				}
				const batcher = batchers[client.url];
				if (batcher?.subIds.includes(subId) && payload.tags) {
					const topicTag = payload.tags.find((t) => t[0] === tag);
					if (topicTag?.[1]) batcher.topics.get(topicTag[1])?.(topicTag[1], content);
				}
			}
		}, () => resubscribeOnReconnect(client)));
		return client.ready;
	}),
	subscribeTopic: (client, topic, onMessage, context) => {
		const handler = (topic, data) => void onMessage(topic, data);
		batchAdd(client, topic, handler);
		const cleanup = () => {
			batchRemove(client, topic);
		};
		return context.kind === "root" ? waitForBatchFlush(client).then(() => cleanup) : cleanup;
	},
	publishTopic: async (client, topic, msg, context) => {
		if (retiredRelays.has(client) || client.isClosed) return context.kind === "announce" ? stopAnnouncing : void 0;
		if (context.kind === "announce") {
			const remainingBackoffMs = getRelayBackoffMs(client);
			if (remainingBackoffMs > 0) return nextAnnounce(fastAnnounce ? fastAnnounceIntervalMs : Math.max(steadyAnnounceIntervalMs, remainingBackoffMs));
		}
		const event = await createEvent(topic, typeof msg === "string" ? msg : toJson(msg));
		const didSend = client.socket.readyState === 1;
		client.send(event);
		if (context.kind !== "announce") return;
		if (!didSend) return nextAnnounce(backoffRelay(client));
		const eventId = fromJson(event)[1].id;
		trackAnnouncementAck(client, eventId);
		return nextAnnounce(fastAnnounce ? fastAnnounceIntervalMs : steadyAnnounceIntervalMs);
	}
});
const getRelaySockets = relayManager.getSockets;
const defaultRelayUrls = [
	"basspistol.org",
	"bucket.coracle.social",
	"chorus.pjv.me",
	"koru.bitcointxoko.org",
	"nos.lol",
	"nostr-01.uid.ovh",
	"nostr-01.yakihonne.com",
	"nostr-relay.corb.net",
	"nostr.data.haus",
	"nostr.islandarea.net",
	"nostr.sathoarder.com",
	"nostr.tegila.com.br",
	"nostr.vulpem.com",
	"purplerelay.com",
	"relay-can.zombi.cloudrodion.com",
	"relay-rpi.edufeed.org",
	"relay.agorist.space",
	"relay.artio.inf.unibe.ch",
	"relay.mostr.pub",
	"relay.mostro.network",
	"relay.sigit.io",
	"relay02.lnfi.network",
	"schnorr.me",
	"social.amanah.eblessing.co",
	"staging.yabu.me",
	"strfry.shock.network",
	"top.testrelay.top",
	"yabu.me/v2"
].map((url) => "wss://" + url);
//#endregion

/**
 * 重置全部中继的 announce 退避与退役状态（本地 vendor 新增）。
 * 场景：满员断开中继后 announce 逐轮 send 失败退避翻倍（60s→15min）；
 * 恢复中继重连成功后调用本函数，让 announce 立即按正常节奏发出，否则重连形同虚设。
 * 参数：无。返回值：无。
 */
export function resetRelayState() {
	relayBackoffs = new WeakMap();
	retiredRelays = new WeakSet();
}

export { createEvent, defaultRelayUrls, getRelaySockets, joinRoom, pauseRelayReconnection, resumeRelayReconnection, selfId, subscribe };

//# sourceMappingURL=index.mjs.map