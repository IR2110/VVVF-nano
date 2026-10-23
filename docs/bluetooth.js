export const BLE_UUID = {
	service: "8f5a0001-31cd-4850-9c6a-ff7b4c4f6e61",
	command: "8f5a0002-31cd-4850-9c6a-ff7b4c4f6e61",
	stream: "8f5a0003-31cd-4850-9c6a-ff7b4c4f6e61",
	patterns: "8f5a0004-31cd-4850-9c6a-ff7b4c4f6e61",
};
const decoder = new TextDecoder(),
	encoder = new TextEncoder();
const MAX_FRAGMENT_BYTES = 65535; // uint16 total length in the on-wire header.
// One in-progress frame per kind. A missing/old fragment cannot corrupt a frame.
export class FragmentReader {
	constructor() {
		this.frames = new Map();
	}
	push(view) {
		if (view.byteLength < 8) throw Error("Bluetoothデータが不正です");
		const kind = view.getUint8(0),
			id = view.getUint16(1, true),
			offset = view.getUint16(3, true),
			total = view.getUint16(5, true);
		const bytes = new Uint8Array(
			view.buffer,
			view.byteOffset + 7,
			view.byteLength - 7,
		);
		if (
			kind > 2 ||
			!total ||
			total > MAX_FRAGMENT_BYTES ||
			offset + bytes.length > total
		)
			throw Error("Bluetoothデータが不正です");
		let frame = this.frames.get(kind);
		if (offset === 0) {
			frame = { id, total, offset: 0, bytes: new Uint8Array(total) };
			this.frames.set(kind, frame);
		}
		if (
			!frame ||
			frame.id !== id ||
			frame.total !== total ||
			frame.offset !== offset
		) {
			this.frames.delete(kind);
			return null;
		}
		frame.bytes.set(bytes, offset);
		frame.offset += bytes.length;
		if (frame.offset !== total) return null;
		this.frames.delete(kind);
		return { kind, bytes: frame.bytes };
	}
}
export function decodeBleState(bytes, patterns) {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.byteLength !== 92 || v.getUint8(0) !== 1)
		throw Error("状態データが不正です");
	const flags = v.getUint8(1),
		pattern = v.getUint8(2),
		status = v.getUint8(3);
	if (status > 4 || !patterns.some((p) => p.id === pattern))
		throw Error("パターン情報が不正です");
	const s = {
		ready: true,
		web: !!(flags & 1),
		jpt: !!(flags & 2),
		enabled: !!(flags & 4),
		pattern,
		pattern_name: patterns.find((p) => p.id === pattern).name,
		state: ["stop", "power", "brake", "coast", "regen_loss"][status],
		mascon: v.getInt8(4),
		power_notches: v.getUint8(5),
		brake_notches: v.getUint8(6),
		mode: ["none", "async", "carrier_sync", "angle_sync"][v.getUint8(7)],
		fake_dsc_n: v.getInt8(8),
		pulses: v.getUint8(9),
		ratio: v.getUint16(10, true),
	};
	[
		"speed_kmh",
		"speed_hz",
		"frequency_hz",
		"amplitude",
		"neutral_unit_jerk",
		"accel_kmh_s",
		"carrier_hz",
		"spread_hz",
		"load_percent",
	].forEach((key, i) => {
		s[key] = v.getFloat32(12 + i * 4, true);
		if (!Number.isFinite(s[key])) throw Error("状態データが不正です");
	});
	[
		"overruns",
		"updates",
		"control_loops",
		"control_period_min_us",
		"control_period_max_us",
		"control_runtime_max_us",
		"control_late",
		"sample_hz",
		"window_us",
		"fps",
		"faults",
	].forEach((key, i) => (s[key] = v.getUint32(48 + i * 4, true)));
	return s;
}
export async function readBlePatterns(meta, command) {
	let page = JSON.parse(decoder.decode(await meta.readValue()));
	// Older firmware exposes its complete list in one read.
	if (Array.isArray(page)) {
		if (!page.length) throw Error("パターン情報が不正です");
		return page;
	}
	const total = page?.total;
	if (page?.version !== 1 || !Number.isInteger(total) || total < 1 || total > 65536)
		throw Error("パターン情報が不正です");
	const patterns = [];
	for (let index = 0; index < total; ++index) {
		// A retry on an already connected device may start at a previous page.
		if (index !== 0 || page.pattern?.id !== 0) {
			await command.writeValueWithResponse(new Uint8Array([0x50, index & 255, index >> 8]));
			page = JSON.parse(decoder.decode(await meta.readValue()));
		}
		if (page?.version !== 1 || page.total !== total || page.pattern?.id !== index ||
			typeof page.pattern.name !== "string" || !page.pattern.name.length)
			throw Error("パターン情報が不正です");
		patterns.push(page.pattern);
	}
	return patterns;
}

export class BleTransport {
	constructor() {
		this.device = null;
		this.command = null;
		this.state = null;
		this.onWave = null;
		this.patterns = [];
		this.pending = new Map();
		this.request = 0;
		this.reader = new FragmentReader();
		this.reconnectTimer = null;
		this.stateAt = 0;
		this.rx = { since: performance.now(), bytes: 0, waves: 0 };
		this.connecting = null;
		this.closed = false;
		this.stream = null;
		this.listener = (e) => this.receive(e.target.value);
	}
	async connect() {
		this.closed = false;
		if (this.connecting) return this.connecting;
		this.connecting = this.connectDevice();
		try {
			await this.connecting;
		} catch (e) {
			this.command = null;
			this.disconnected();
			throw e;
		} finally {
			this.connecting = null;
		}
	}
	async connectDevice() {
		if (!navigator.bluetooth)
			throw Error("Bluetooth対応のChromeで開いてください。");
		if (!this.device) {
			const granted = navigator.bluetooth.getDevices
				? await navigator.bluetooth.getDevices()
				: [];
			const previous = localStorage.getItem("vvvf-device");
			const known = granted.filter(
				(d) => d.name === "VVVF nano" || d.id === previous,
			);
			this.device =
				known.length === 1
					? known[0]
					: await navigator.bluetooth.requestDevice({
							filters: [{ name: "VVVF nano" }],
							optionalServices: [BLE_UUID.service],
						});
			localStorage.setItem("vvvf-device", this.device.id);
			this.device.addEventListener("gattserverdisconnected", () =>
				this.disconnected(),
			);
		}
		if (this.device.gatt.connected && this.command) return;
		const server = await this.device.gatt.connect(),
			service = await server.getPrimaryService(BLE_UUID.service);
		const command = await service.getCharacteristic(BLE_UUID.command);
		const meta = await service.getCharacteristic(BLE_UUID.patterns);
		this.patterns = await readBlePatterns(meta, command);
		this.reader = new FragmentReader();
		const stream = await service.getCharacteristic(BLE_UUID.stream);
		if (this.stream)
			this.stream.removeEventListener(
				"characteristicvaluechanged",
				this.listener,
			);
		this.stream = stream;
		stream.addEventListener("characteristicvaluechanged", this.listener);
		this.rx = { since: performance.now(), bytes: 0, waves: 0 };
		await stream.startNotifications();
		this.command = command;
	}
	receive(view) {
		try {
			const frame = this.reader.push(view);
			if (!frame) return;
			if (frame.kind === 0) {
				this.state = decodeBleState(frame.bytes, this.patterns);
				this.stateAt = performance.now();
			} else if (frame.kind === 1) {
				this.onWave?.(frame.bytes.buffer);
				++this.rx.waves;
			}
			else {
				const reply = JSON.parse(decoder.decode(frame.bytes)),
					pending = this.pending.get(reply.request);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(reply.request);
					pending.resolve(
						new Response(JSON.stringify(reply), {
							status: reply.status,
						}),
					);
				}
			}
			this.rx.bytes += frame.bytes.length;
			const now = performance.now(), elapsed = now - this.rx.since;
			if (elapsed >= 5000) {
				console.info("BLE RX", {
					kBps: +(this.rx.bytes / elapsed).toFixed(1),
					waveFps: +(this.rx.waves * 1000 / elapsed).toFixed(1),
				});
				this.rx = { since: now, bytes: 0, waves: 0 };
			}
		} catch {
			/* discard malformed/incomplete telemetry, keeping the control lease independent */
		}
	}
	disconnected() {
		if (this.stream)
			this.stream.removeEventListener(
				"characteristicvaluechanged",
				this.listener,
			);
		this.stream = null;
		this.command = null;
		this.state = null;
		this.reader = new FragmentReader();
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(Error("Bluetoothの接続が途絶しました。"));
		}
		this.pending.clear();
		if (this.device && !this.closed && !this.reconnectTimer)
			this.reconnectTimer = setTimeout(async () => {
				this.reconnectTimer = null;
				try {
					await this.connect();
				} catch {
					this.disconnected();
				}
			}, 2000);
	}
	async fetch(path, options = {}) {
		if (!this.device?.gatt.connected || !this.command)
			throw Error("Bluetooth接続待ち");
		if (path === "/api/command") {
			const request = ++this.request,
				body = encoder.encode(
					JSON.stringify({ ...JSON.parse(options.body), request }),
				);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(request);
					reject(Error("Bluetooth応答待ちがタイムアウトしました。"));
				}, 1400);
				this.pending.set(request, { resolve, reject, timer });
				// Application acknowledgement includes the request ID and policy result.
				// Avoid Windows ATT response stalls during simultaneous notifications.
				this.command.writeValueWithoutResponse(body).catch((e) => {
					clearTimeout(timer);
					this.pending.delete(request);
					reject(e);
				});
			});
		}
		if (path === "/api/patterns")
			return new Response(JSON.stringify(this.patterns));
		if (path === "/api/state") {
			if (!this.state || performance.now() - this.stateAt > 1200)
				throw Error("状態更新待ち");
			return new Response(JSON.stringify(this.state));
		}
		throw Error("通信経路が不正です");
	}
	close() {
		this.closed = true;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		if (this.device) {
			const device = this.device;
			this.device = null;
			device.gatt.disconnect();
		}
	}
}
