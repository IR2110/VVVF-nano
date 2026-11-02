import {driveInfo, mapNotch, coefficients, motionRate, advanceMotion} from "./consist-model.js";

// Runs once per pair on the host's leader Worker. Endpoint speed telemetry is
// used for the stopped/start gate; the shared trajectory is authoritative after it.
export class ConsistEngine {
	constructor({members, token, emit, now}) {
		Object.assign(this, {members, token, emit, now});
		this.samples = new Map();
		this.sequence = 0;
		this.lastSent = new Map();
	}
	receive(id, message) {
		if (!this.members.includes(id)) return;
		if (message.type === "detach") { this.stop(); return; }
		if (message.type === "input") {
			const source = this.samples.get(id);
			if (!this.model || !source?.owned || !source.web || !Number.isInteger(message.notch) ||
				message.notch < -source.spec.brake || message.notch > source.spec.power) return;
			this.command = {actor: id, notch: message.notch, hold: false};
			this.rebuild();
			return;
		}
		if (message.type !== "sample" || this.stopped) return;
		const sample = message.sample;
		const spec = driveInfo(sample?.drive);
		if (!spec || sample.token !== this.token || !Number.isFinite(sample.speed) ||
			!Number.isFinite(sample.offset) || !Number.isInteger(sample.revision) || sample.revision < 1) return;
		const previous = this.samples.get(id);
		this.samples.set(id, {...sample, spec});
		if (!this.model) {
			if (this.members.every(member => this.samples.get(member)?.web && this.samples.get(member).speed === 0)) {
				const actor = this.members[0];
				this.command = {actor, notch: -this.samples.get(actor).spec.brake, hold: false};
				this.rebuild(true);
			}
		} else if (previous && (previous.pattern !== sample.pattern || previous.revision !== sample.revision)) {
			this.command = {actor: id, notch: previous.pattern !== sample.pattern ? -spec.brake : sample.notch,
				hold: previous.pattern === sample.pattern && sample.hold};
			this.rebuild();
		}
		this.tick();
	}
	rebuild(start = false) {
		if (this.stopped || this.members.some(id => !this.samples.has(id))) return;
		const at = this.now() + 80;
		const speed = start ? 0 : advanceMotion(this.model, at);
		const limit = Math.min(...this.members.map(id => this.samples.get(id).spec.limit));
		const values = this.members.map(id => {
			const other = this.members.find(member => member !== id);
			return mapNotch(this.command.notch, this.samples.get(id).spec, this.samples.get(other).spec, id === this.command.actor);
		});
		const coeff = values.flatMap((value, index) => coefficients(this.samples.get(this.members[index]).spec, value.effective, this.command.hold));
		this.model = {at, speed: Math.min(limit, speed), limit, coeff, values, sequence: ++this.sequence};
		this.lastRefresh = this.now();
		this.lastSent.clear();
		this.tick();
	}
	tick() {
		if (!this.model || this.stopped) return;
		const now = this.now();
		const speed = advanceMotion(this.model, now);
		if (now - this.lastRefresh >= 2000 && speed > 0 && speed < this.model.limit && motionRate(this.model.coeff, speed) !== 0) {
			this.rebuild();
			return;
		}
		for (const [index, id] of this.members.entries()) {
			const sample = this.samples.get(id);
			if (sample.sequence >= this.model.sequence || now - (this.lastSent.get(id) ?? -Infinity) < 150) continue;
			this.lastSent.set(id, now);
			this.emit(id, {type: "motion", frame: {
				token: this.token, sequence: this.model.sequence,
				at_ms: Math.round(this.model.at + sample.offset) >>> 0,
				speed: this.model.speed, limit: this.model.limit, coeff: this.model.coeff,
				notch: this.model.values[index].effective, display: this.model.values[index].display,
				revision: sample.revision, pattern: sample.pattern,
			}});
		}
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const id of this.members) this.emit(id, {type: "stop", token: this.token});
	}
}
