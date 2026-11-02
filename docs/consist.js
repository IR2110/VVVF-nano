// Tabs only negotiate membership. Motion and ongoing synchronization live in
// the inverters, so a hidden managing page does not have to run a timer.
export class ConsistCoordinator {
	constructor({session, send, onOffer, onStatus, onError, channel}) {
		Object.assign(this, {session, send, onOffer, onStatus, onError});
		const page = globalThis.location?.href?.split("#")[0] ?? "";
		this.channel = channel ?? (globalThis.BroadcastChannel ? new BroadcastChannel(`vvvf-consist-v1:${page}`) : null);
		this.peers = new Map();
		this.pending = new Map();
		this.identity = null;
		this.ready = this.asked = this.busy = false;
		this.serial = 0;
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
		const changed = identity.state !== this.identity.state || identity.token !== this.identity.token ||
			identity.manager !== this.identity.manager;
		Object.assign(this.identity, identity);
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
				try { await this.send("uncouple"); } catch {} // Physical disconnect is the other teardown path.
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
					value.address !== peer.address || value.type !== peer.address_type) throw Error("併結相手の状態が変わりました。");
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
			await this.send("couple", value);
			this.identity.token = value.token;
			this.identity.manager = true;
			this.announce();
			this.onStatus?.("waiting");
		} catch (error) {
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
		const local = {address: other.address, type: other.address_type, token};
		const remote = {address: this.identity.address, type: this.identity.address_type, token};
		try {
			// The smaller BLE address initiates the direct connection. Configure
			// the peripheral first, so it can recognize that incoming connection.
			if (this.identity.address < other.address) {
				await this.rpc(other.session, "configure", remote);
				await this.configure(local);
			} else {
				await this.configure(local);
				await this.rpc(other.session, "configure", remote);
			}
		} catch (error) {
			// Roll back both ends, including an acknowledgement lost in transit.
			await Promise.allSettled([
				this.reservation === token ? this.send("uncouple") : Promise.resolve(),
				this.rpc(other.session, "rollback", {token}),
			]);
			this.reservation = null;
			this.onError?.(error.message);
		} finally { this.busy = false; }
	}
	disconnected() {
		clearTimeout(this.settleTimer);
		if (this.identity) this.post({type: "leave"});
		this.identity = null;
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
	return value?.version === 1 && /^[0-9a-f]{12}$/.test(value.address) &&
		(value.address_type === 0 || value.address_type === 1) &&
		["off", "waiting", "active"].includes(value.state);
}
