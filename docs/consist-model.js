export function driveInfo(data) {
	if (!Array.isArray(data) || data.length !== 9 || !data.every(Number.isFinite)) return null;
	const [power, brake, accel, decel, boundary, square, hz, neutral, limit] = data;
	if (!Number.isInteger(power) || !Number.isInteger(brake) || power < 1 || brake < 1 ||
		power > 32 || brake > 32 || accel <= 0 || decel <= 0 || hz <= 0 || limit <= 0) return null;
	return {power, brake, accel, decel, boundary, square, hz, neutral, limit};
}
export function mapNotch(value, own, other, source) {
	const max = value > 0 ? own.power : own.brake;
	const otherMax = value > 0 ? other.power : other.brake;
	const full = Math.abs(value) >= Math.min(max, otherMax);
	return {effective: Math.sign(value) * (full ? max : Math.abs(value)),
		display: source ? value : Math.sign(value) * (full ? max : Math.abs(value))};
}
export function coefficients(spec, notch, hold) {
	if (hold) return [0, 0, 0];
	if (notch < 0) return [-spec.decel * -notch / spec.brake / 2, 0, 0];
	if (!notch) return [spec.neutral / 2, 0, 0];
	const envelope = spec.accel * spec.boundary;
	return [spec.accel * notch / spec.power / 2, envelope / 2, envelope * spec.square / 2].map(Math.fround);
}
export function motionRate(coeff, speed) {
	let rate = 0;
	for (let i = 0; i < 6; i += 3) {
		let part = coeff[i];
		if (part > 0 && speed > 0) part = Math.min(part, coeff[i + 1] / speed, coeff[i + 2] / (speed * speed));
		rate += part;
	}
	return rate;
}
export function advanceMotion(model, time) {
	let speed = model.speed, elapsed = Math.max(0, time - model.at);
	while (elapsed > 0) {
		const step = Math.min(10, elapsed), dt = step / 1000;
		const midpoint = Math.max(0, Math.min(model.limit, speed + motionRate(model.coeff, speed) * dt / 2));
		speed = Math.max(0, Math.min(model.limit, speed + motionRate(model.coeff, midpoint) * dt));
		elapsed -= step;
	}
	return speed;
}
