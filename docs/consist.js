// Membership and common motion stay inside the host. Only a compact local
// trajectory goes to each inverter; there is no inverter-to-inverter BLE link.
export class ConsistCoordinator {
	constructor({session, send, sendMotion, calibrate, onOffer, onStatus, onNotch, onError, channel}) {
		Object.assign(this, {session, send, sendMotion, calibrate, onOffer, onStatus, onNotch, onError});
		const page = globalThis.location?.href?.split("#")[0] ?? "";
		this.scope = page;
		this.channel = channel ?? (globalThis.BroadcastChannel ? new BroadcastChannel(`vvvf-consist-v1:${page}`) : null);
		this.peers = new Map();
		this.pending = new Map();
		this.identity = null;
		this.ready = this.asked = this.busy = false;
		this.serial = 0;
		this.inputRequest = 0;
		if (this.channel) this.channel.onmessage = event => void this.receive(event.data);
	}
	post(message) { this.channel?.postMessage({...message, from: this.session}); }
	joined(identity) {
		this.disconnected();
		if (!validIdentity(identity)) return;
		this.identity = {...identity, session: this.session, joinedAt: Date.now()};
		this.settling = true;
		this.settleTimer = setTimeout(() => {this.settling = false; this.offer();}, 150);
		this.announce();
		this.post({type: "discover"});
		this.onStatus?.(identity.state);
	}
	update(identity) {
		if (!this.identity || !validIdentity(identity)) return;
		// Notifications already in the BLE queue must not restart a detached pair.
		if (this.detachingToken && identity.token === this.detachingToken && identity.state !== "off") return;
		if (identity.state === "off") {
			this.detachingToken = null;
			clearTimeout(this.detachTimer);
		}
		const changed = identity.state !== this.identity.state || identity.token !== this.identity.token ||
			identity.manager !== this.identity.manager;
		Object.assign(this.identity, identity);
		if (identity.state === "off" && this.worker) this.stopWorker();
		if (changed) { this.announce(); this.onStatus?.(identity.state); }
	}
	allowOffer() { this.ready = true; this.offer(); }
	announce() { if (this.identity) this.post({type: "presence", identity: this.identity}); }
	pair() {
		if (!this.identity) return [];
		const entries = [this.identity, ...this.peers.values()].sort((a, b) =>
			a.joinedAt - b.joinedAt || a.session.localeCompare(b.session));
		const unique = entries.filter((entry, index) => entries.findIndex(p => p.address === entry.address) === index);
		return unique.slice(0, 2);
	}
	offer() {
		if (!this.ready || this.settling || this.asked || this.busy || this.identity?.state !== "off") return;
		const pair = this.pair();
		if (pair.length !== 2 || pair[1].session !== this.session || pair.some(p => p.state !== "off")) return;
		this.asked = true;
		this.candidate = pair[0];
		this.onOffer?.();
	}
	async receive(message) {
		if (!message || message.from === this.session || typeof message.from !== "string") return;
		if (message.type === "discover") { this.announce(); return; }
		if (message.type === "presence") {
			const p = message.identity;
			if (!validIdentity(p) || p.session !== message.from || !Number.isFinite(p.joinedAt)) return;
			this.peers.set(message.from, p);
			this.offer();
			return;
		}
		if (message.type === "leave") {
			const peer = this.peers.get(message.from);
			this.peers.delete(message.from);
			// Closing a managing tab also asks the surviving manager to detach.
			// This covers a lost BLE leave on an OS connection shared with observers.
			if (peer?.manager && this.identity?.manager && peer.token && peer.token === this.identity.token) {
				await this.detach();
			}
			return;
		}
		if (message.to !== this.session) return;
		if (message.type === "reply") {
			const pending = this.pending.get(message.id);
			if (!pending || pending.to !== message.from) return;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error) pending.reject(Error(message.error));
			else pending.resolve();
			return;
		}
		if (message.type !== "configure" && message.type !== "rollback") return;
		const peer = this.peers.get(message.from), value = message.value;
		if (!this.identity || !peer || peer.address === this.identity.address ||
			!value || !/^[0-9a-f]{16}$/.test(value.token)) return;
		try {
			if (message.type === "configure") {
				const pair = this.pair();
				if (this.busy || this.identity.state !== "off" || pair.length !== 2 ||
					!pair.some(p => p.session === message.from) || !pair.some(p => p.session === this.session) ||
					value.version !== 2 || !Array.isArray(value.members) || value.members.length !== 2 ||
					!value.members.includes(this.session) || !value.members.includes(message.from)) throw Error("併結相手の状態が変わりました。");
				await this.configure(value);
			} else if (this.reservation === value.token) {
				await this.send("uncouple");
				this.reservation = null;
			}
			this.post({type: "reply", to: message.from, id: message.id});
		} catch (error) {
			this.post({type: "reply", to: message.from, id: message.id, error: error.message});
		}
	}
	async configure(value) {
		// Reserve before awaiting the BLE write; a second request cannot race it.
		this.reservation = value.token;
		this.identity.state = "waiting";
		this.announce();
		try {
			await this.send("couple", {version: 2, token: value.token});
			this.identity.token = value.token;
			this.identity.manager = true;
			if (this.sendMotion) {
				this.clock = await this.calibrate();
				this.startWorker(value);
			}
			this.announce();
			this.onStatus?.("waiting");
		} catch (error) {
			await this.send("uncouple").catch(() => {});
			this.stopWorker();
			this.identity.state = "off";
			this.reservation = null;
			this.announce();
			throw error;
		}
	}
	rpc(to, type, value) {
		const id = ++this.serial;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(Error("相手のタブと通信できません。両方のタブを表示して再接続してください。"));
			}, 5000);
			this.pending.set(id, {to, resolve, reject, timer});
			this.post({type, to, id, value});
		});
	}
	async accept() {
		if (this.busy || !this.identity || !this.candidate) return;
		const other = this.peers.get(this.candidate.session);
		if (!other || other.state !== "off" || this.identity.state !== "off") {
			this.onError?.("併結相手の接続状態が変わりました。再接続してください。");
			return;
		}
		this.busy = true;
		const bytes = crypto.getRandomValues(new Uint8Array(8));
		const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
		const value = {version: 2, token, members: [this.session, other.session]};
		try {
			await this.rpc(other.session, "configure", value);
			await this.configure(value);
		} catch (error) {
			// Roll back both ends, including an acknowledgement lost in transit.
			await Promise.allSettled([
				this.send("uncouple"),
				this.rpc(other.session, "rollback", {token}),
			]);
			this.reservation = null;
			this.onError?.(error.message);
		} finally { this.busy = false; }
	}
	startWorker(value) {
		this.stopWorker();
		this.inputRequest = 0;
		const worker = new Worker(new URL("./consist-worker.js?v=20261102-immediate", import.meta.url), {type: "module"});
		this.worker = worker;
		worker.onmessage = ({data}) => {
			if (this.worker !== worker || this.identity?.token !== value.token || !this.identity.manager) return;
			if (data.type === "notch" && (!this.pendingInput || data.request >= this.pendingInput)) {
				this.pendingInput = 0;
				this.onNotch?.(data.notch, data.pattern);
			}
			if (data.type === "motion") { this.motionWanted = data.frame; void this.flushMotion(); }
			if (data.type === "stop" && data.token === value.token) void this.detach();
		};
		worker.onerror = () => {
			if (this.worker !== worker || this.identity?.token !== value.token) return;
			this.onError?.("併結の共通処理が停止しました。再接続してください。");
			this.post({type: "leave"});
			void this.detach();
		};
		worker.postMessage({type: "init", session: this.session, scope: this.scope,
			token: value.token, members: value.members});
		if (this.lastSample) this.sample(...this.lastSample);
	}
	stopWorker() {
		if (this.worker) {
			const worker = this.worker;
			worker.onmessage = worker.onerror = null;
			worker.postMessage({type: "detach"});
			setTimeout(() => worker.terminate(), 100);
		}
		this.worker = null;
		this.pendingInput = 0;
		this.motionWanted = null;
	}
	async detach() {
		const token = this.identity?.token;
		if (!token || this.detachAttempt) return;
		if (this.detachingToken !== token) {
			this.detachingToken = token;
			this.stopWorker();
			this.identity.state = "off";
			this.announce();
			this.onStatus?.("off");
		}
		clearTimeout(this.detachTimer);
		const attempt = {};
		this.detachAttempt = attempt;
		try { await this.send("uncouple", {token}); }
		catch (error) { if (this.detachingToken === token) this.onError?.(error.message); }
		finally {
			if (this.detachAttempt === attempt) {
				this.detachAttempt = null;
				// A lost acknowledgement/notification must not leave the firmware
				// following its old trajectory until the user closes the tab.
				if (this.detachingToken === token) this.detachTimer = setTimeout(() => void this.detach(), 250);
			}
		}
	}
	sample(state, patterns, client, clock) {
		this.lastSample = [state, patterns, client, clock];
		const info = this.identity;
		if (!this.worker || !info?.manager || !state || !info.token) return;
		const pattern = info.pattern ?? state.pattern;
		const drive = patterns?.find(p => p.id === pattern)?.drive;
		const offset = (clock ?? this.clock)?.offset;
		if (!drive || !Number.isFinite(offset)) return;
		const sample = {token: info.token, pattern, drive, offset,
			web: state.web, speed: state.speed_kmh, owned: !!client?.control,
			revision: info.revision, notch: info.notch, hold: !!info.hold, command: info.command ?? 0};
		this.worker.postMessage({type: "sample", sample});
		if (!sample.owned) this.pendingInput = 0;
	}
	controlNotch(notch) {
		if (!this.worker || this.identity?.state !== "active" || !this.identity.manager) return false;
		this.pendingInput = ++this.inputRequest;
		this.worker.postMessage({type: "input", notch, request: this.pendingInput});
		return true;
	}
	async flushMotion() {
		if (this.motionSending) return;
		this.motionSending = true;
		try {
			while (this.motionWanted) {
				const frame = this.motionWanted;
				this.motionWanted = null;
				if (this.identity?.token !== frame.token || !this.identity.manager) break;
				const worker = this.worker;
				await this.sendMotion(frame, () => this.worker === worker && this.identity?.token === frame.token &&
					(frame.request ?? 0) >= this.inputRequest &&
					(!this.motionWanted || this.motionWanted.sequence <= frame.sequence));
			}
		} catch (error) { this.onError?.(error.message); }
		finally { this.motionSending = false; }
	}
	disconnected() {
		this.stopWorker();
		clearTimeout(this.settleTimer);
		if (this.identity) this.post({type: "leave"});
		this.identity = null;
		this.detachingToken = null;
		this.detachAttempt = null;
		clearTimeout(this.detachTimer);
		this.ready = this.asked = false;
		this.reservation = this.candidate = null;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(Error("Bluetoothの接続が途絶しました。"));
		}
		this.pending.clear();
		this.peers.clear();
		this.onStatus?.("off");
	}
}
function validIdentity(value) {
	return value?.version === 2 && /^[0-9a-f]{12}$/.test(value.address) &&
		["off", "waiting", "active"].includes(value.state);
}
