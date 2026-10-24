import {
	displayState,
	decodeScope,
	waveformY,
	formatSpeed,
	pwmBadgeMode,
	STATE_PERIOD_MS,
} from "./telemetry.js";
import { BleTransport } from "./bluetooth.js?v=20261023-wavepack";
const session = crypto.randomUUID();
const bluetooth = new BleTransport(session);
const $ = (id) => document.getElementById(id);
let state = null,
	online = false,
	owned = false,
	epoch = 0,
	commandQueue = Promise.resolve(),
	notchWanted = null,
	notchInFlight = null,
	notchInFlightAt = 0,
	notchSending = false;
let masconDrag = null;
let frame = null,
	waveDirty = true,
	patternsLoaded = false,
	lastStateAt = 0,
	patternSignature = "";
const canvas = $("scope"),
	ctx = canvas.getContext("2d");
const darkTheme = matchMedia("(prefers-color-scheme: dark)");
darkTheme.addEventListener("change", () => (waveDirty = true));
function acceptWave(buffer) {
	try {
		frame = decodeScope(buffer);
		waveDirty = true;
	} catch {} // Discard invalid frames without clearing the last complete one.
}
bluetooth.onWave = acceptWave;
const waveDialog = $("wave-dialog");
bluetooth.onMembership = (client) => {
	if (!client?.wave) {frame = null; waveDirty = true;}
	if (!client && waveDialog.open) waveDialog.close();
	const canControl = !!client?.control && bluetooth.web;
	if (owned && !canControl) loseControl();
	owned = canControl;
	refreshControls();
};
bluetooth.onJoin = (client) => {
	if (!client.first && !waveDialog.open) waveDialog.showModal();
};
async function setWave(show) {
	try {await command("wave", show);}
	catch (error) {message(error.message);}
}
$("wave-yes").addEventListener("click", () => {waveDialog.close(); void setWave(true);});
$("wave-no").addEventListener("click", () => waveDialog.close());
$("toggle-wave").addEventListener("click", () => void setWave(!bluetooth.client?.wave));
// A bfcache restore is a fresh join; it must never replay the old notch.
window.addEventListener("pageshow", (event) => {
	if (event.persisted) {bluetooth.closed = false; void bluetooth.connect().catch((e) => message(e.message));}
});
// Use the same condition as the mobile stylesheet; mouse-operated PCs retain
// the fixed desktop console even in a narrow window.
const mobileLayout = matchMedia("(max-width: 1023px) and (pointer: coarse)");
let pulseFitKey = "";
function fitPulseValue() {
	const pulse = document.querySelector(".pulse"),
		value = $("pulse-value"),
		detail = $("pulse-detail");
	const mobile = mobileLayout.matches,
		fontSize = mobile ? 30 : 73;
	const key = value.textContent + "|" + detail.textContent +
		(mobile ? `|mobile/${pulse.clientWidth}` : "");
	if (key === pulseFitKey) return;
	pulseFitKey = key;
	value.style.fontSize = `${fontSize}px`;
	const css = mobile ? getComputedStyle(pulse) : null;
	const available = mobile
		? pulse.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) -
			$("mode-badge").offsetWidth - parseFloat(css.columnGap)
		: 824 -
		38 -
		30 -
		216 -
		23 -
		(detail.textContent
			? detail.getBoundingClientRect().width / layoutScale + 8
			: 0);
	const natural = value.scrollWidth;
	if (natural > available)
		value.style.fontSize = `${Math.floor((fontSize * available) / natural)}px`;
}
let layoutScale = 1;
let meterTravel = 580, meterLayoutKey = "", layoutReady = false, wasMobile = false;
function resizeLayout() {
	const mobile = mobileLayout.matches, relayout = mobile || wasMobile;
	wasMobile = mobile;
	if (relayout) endMasconDrag();
	if (mobile) {
		layoutScale = 1;
		$("stage").style.removeProperty("width");
		$("stage").style.removeProperty("height");
		$("console").style.removeProperty("transform");
	} else {
		layoutScale = Math.min(innerWidth / 1600, innerHeight / 900);
		$("stage").style.width = `${1600 * layoutScale}px`;
		$("stage").style.height = `${900 * layoutScale}px`;
		$("console").style.transform = `scale(${layoutScale})`;
	}
	if (layoutReady && relayout) {
		fitNotchScale();
		setNotchBadge(Number($("mascon").value));
		resizeSpeedometer();
		pulseFitKey = "";
		fitPulseValue();
	}
}
addEventListener("resize", resizeLayout);
mobileLayout.addEventListener("change", resizeLayout);
resizeLayout();
const errors = {
	offline: "ESP32との通信が途絶しました。再接続を試みています。",
	moving: "パターンは停止中に変更できます。",
	full: "同時接続は3画面までです。",
	session: "接続情報が失われました。再接続します。",
	owner: "操作権が解除されました。Web操作を開始してください。",
	persistence: "パターンを保存できませんでした。",
	notch: "ノッチが範囲外です。",
};
function message(text = "") {
	$("message").textContent = text;
}
function loseControl() {
	owned = false;
	notchWanted = null;
	notchInFlight = null;
	epoch++;
	refreshControls();
}
function disconnected() {
	if (online || frame) {
		frame = null;
		waveDirty = true;
	}
	if (online) {
		online = false;
		loseControl();
	}
	$("connection").textContent =
		!bluetooth.device ? "接続待ち" : bluetooth.connecting && !bluetooth.everJoined ? "接続中" : "再接続中";
	$("connection").className =
		!bluetooth.device ? "waiting" : "offline";
	$("operation-note").textContent =
		!bluetooth.device
			? "Bluetooth接続から「VVVF nano」を選択してください。"
			: bluetooth.connecting && !bluetooth.everJoined
				? "Bluetoothの接続と形式情報の読込みを行っています。"
			: "基板操作へ戻ります。接続後、Web操作開始で再開できます。";
	refreshControls();
}
async function fetchApi(path, options = {}) {
	const result = await bluetooth.fetch(path, options);
	if (!result.ok) {
		let error = {};
		try {
			error = await result.json();
		} catch {}
		const e = Error(errors[error.error] || "通信を確認してください。");
		e.code = error.error;
		e.status = result.status;
		throw e;
	}
	return result;
}
function command(action, value) {
	const commandEpoch = epoch;
	const result = commandQueue
		.catch(() => {})
		.then(async () => {
			if (commandEpoch !== epoch && action !== "release")
				throw Error("操作は取り消されました。");
			return fetchApi("/api/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action,
					session,
					...(value === undefined ? {} : { value }),
				}),
			});
		});
	commandQueue = result;
	return result;
}
function refreshControls() {
	$("take-control").disabled = !online || owned;
	$("release-control").disabled = !online || !state?.web;
	$("toggle-wave").disabled = !online;
	$("toggle-wave").textContent = bluetooth.client?.wave ? "波形表示を終了" : "波形を表示";
	$("mascon").disabled = !online || !owned;
	if ($("mascon").disabled) endMasconDrag();
	document
		.querySelectorAll(".pattern")
		.forEach(
			(b) =>
				(b.disabled =
					!online ||
					!state ||
					state.speed_hz > 0 ||
					!owned),
		);
}
function setNotchBadge(value) {
	const badge = $("notch-badge");
	badge.textContent =
		value > 0 ? `P${value}` : value < 0 ? `B${-value}` : "N";
	const min = Number($("mascon").min),
		max = Number($("mascon").max);
	badge.className =
		value === 0
			? "neutral"
			: value === max
				? "full-power"
				: value === min
					? "full-brake"
					: value > 0
						? "power"
						: "brake";
	const scale = $("notch-scale"),
		neutral = scale.querySelector('[data-notch="0"]'),
		selected = scale.querySelector(`[data-notch="${value}"]`);
	const neutralAt = neutral.offsetTop + neutral.offsetHeight / 2,
		selectedAt = selected.offsetTop + selected.offsetHeight / 2;
	scale.dataset.mode = badge.className;
	scale.style.setProperty(
		"--active-top",
		`${Math.min(neutralAt, selectedAt)}px`,
	);
	scale.style.setProperty(
		"--active-height",
		`${Math.abs(neutralAt - selectedAt)}px`,
	);
	scale
		.querySelectorAll("span")
		.forEach((mark) =>
			mark.classList.toggle(
				"selected",
				Number(mark.dataset.notch) === value,
			),
		);
}
function buildScale(power, brake) {
	const key = `${power}/${brake}`;
	if (patternSignature === key) return;
	patternSignature = key;
	const scale = $("notch-scale");
	scale.replaceChildren();
	for (let n = -brake; n <= power; n++) {
		const mark = document.createElement("span");
		mark.textContent = n < 0 ? `B${-n}` : n > 0 ? `P${n}` : "N";
		mark.dataset.notch = n;
		mark.title = mark.textContent;
		mark.className = n < 0 ? "brake" : n > 0 ? "power" : "neutral";
		if (n === -brake) mark.classList.add("top");
		if (n === power) mark.classList.add("bottom");
		scale.append(mark);
	}
	$("mascon").min = -brake;
	$("mascon").max = power;
	fitNotchScale();
}
function fitNotchScale() {
	const scale = $("notch-scale");
	const css = getComputedStyle(scale),
		rowHeight = scale.firstElementChild.offsetHeight;
	const travel =
		scale.clientHeight -
		parseFloat(css.paddingTop) -
		parseFloat(css.paddingBottom) -
		rowHeight;
	const intervals = scale.children.length - 1;
	scale.style.gap = `${intervals > 0 ? Math.max(0, travel / intervals - rowHeight) : 0}px`;
}
function render(s) {
	if (
		state &&
		(state.window_us !== s.window_us || state.sample_hz !== s.sample_hz)
	) {
		frame = null;
		waveDirty = true;
	}
	state = s;
	const text = displayState(s);
	$("console").className = s.state;
	if (s.window_us)
		document
			.querySelector(".scope")
			.setAttribute(
				"aria-label",
				`ゲートから生成した線間電圧波形、${s.window_us / 1000}ミリ秒`,
			);
	for (const [id, key] of [
		["frequency", "frequency"],
		["amplitude", "amplitude"],
		["mode-badge", "mode"],
		["pulse-value", "pulse"],
		["pulse-detail", "detail"],
		["state-badge", "label"],
	])
		$(id).textContent = text[key].replace("—", "-");
	$("pulse-value").textContent = text.pulse
		.replace("—", "-")
		.replace(" パルス", mobileLayout.matches ? " P" : "パルス")
		.replace(" Hz", "Hz");
	$("pulse-detail").textContent = text.detail.replace(" Hz", "Hz");
	document.querySelector(".pulse").dataset.mode = pwmBadgeMode(s);
	fitPulseValue();
	$("speed").textContent = formatSpeed(s.speed_kmh);
	$("running-pattern").textContent = s.pattern_name;
	const meterPosition = (Math.max(0, Math.min(160, s.speed_kmh)) / 160) * meterTravel;
	$("needle").setAttribute("transform", `translate(${meterPosition} 0)`);
	$("speed-fill").setAttribute("width", meterPosition);
	buildScale(s.power_notches, s.brake_notches);
	// The acknowledgement can arrive before the next drive telemetry snapshot.
	// Hold the requested notch until telemetry catches up.
	if (!notchSending && (notchInFlight === s.mascon ||
		performance.now() - notchInFlightAt > 1500)) notchInFlight = null;
	if (!masconDrag && notchWanted === null && notchInFlight === null) {
		$("mascon").value = s.mascon;
		setNotchBadge(s.mascon);
	}
	document.querySelectorAll(".pattern").forEach((b) => {
		const selected = Number(b.dataset.id) === s.pattern;
		b.classList.toggle("selected", selected);
		b.setAttribute("aria-selected", String(selected));
	});
	$("pattern-note").textContent =
		s.speed_hz > 0 ? "運転中は変更できません" : "停止中に変更できます";
	$("operation-note").textContent = owned
		? "Web操作中：基板スイッチは無視します。"
		: s.web
			? "別の画面がWeb操作中です。Web操作開始で操作権を移せます。"
			: "基板操作中：Web操作開始でB" +
				s.brake_notches +
				"から操作します。";
	if (s.faults) message(`ESP32の異常を検知しました（${s.faults}）。`);
	refreshControls();
}
async function loadPatterns() {
	const r = await fetchApi("/api/patterns");
	const list = await r.json();
	if (!Array.isArray(list) || !list.length)
		throw Error("パターン情報が不正です");
	$("pattern-list").replaceChildren();
	for (const p of list) {
		const b = document.createElement("button");
		b.className = "pattern";
		b.dataset.id = p.id;
		b.textContent = p.name;
		b.role = "option";
		b.addEventListener("click", async () => {
			try {
				await command("pattern", p.id);
				message();
			} catch (e) {
				message(e.message);
			}
		});
		$("pattern-list").append(b);
	}
	patternsLoaded = true;
	refreshControls();
}
async function pollState() {
	const started = performance.now();
	try {
		const result = await fetchApi("/api/state");
		const s = await result.json();
		if (!s.ready) throw Error("起動待ち");
		lastStateAt = performance.now();
		if (!online) waveDirty = true;
		online = true;
		$("connection").textContent = "Bluetooth";
		$("connection").className = "online";
		const canControl = !!bluetooth.client?.control && bluetooth.web;
		if (owned && !canControl) loseControl();
		owned = canControl;
		render(s);
		if (!patternsLoaded) await loadPatterns();
	} catch {
		disconnected();
	}
	setTimeout(
		pollState,
		Math.max(0, STATE_PERIOD_MS - (performance.now() - started)),
	);
}
async function sendLatestNotch() {
	if (notchSending) return;
	notchSending = true;
	try {
		while (notchWanted !== null && owned) {
			const value = notchWanted;
			notchWanted = null;
			notchInFlight = value;
			notchInFlightAt = performance.now();
			await command("notch", value);
		}
	} catch (e) {
		notchInFlight = null;
		message(e.message);
		if (e.status === 403) loseControl();
	} finally {
		notchSending = false;
	}
}
function requestNotch(value) {
	if (!owned || !online) return;
	value = Math.max(
		Number($("mascon").min),
		Math.min(Number($("mascon").max), value),
	);
	const selected = document.querySelector("#notch-scale span.selected");
	if (selected && value === Number(selected.dataset.notch)) return;
	$("mascon").value = value;
	setNotchBadge(value);
	notchWanted = value;
	void sendLatestNotch();
}
$("mascon").addEventListener("input", (e) =>
	requestNotch(Number(e.target.value)),
);
function pointerNotch(e) {
	if (!masconDrag || e.pointerId !== masconDrag.pointerId) return;
	const marks = [...document.querySelectorAll("#notch-scale span")];
	const y = e.clientY - masconDrag.offsetY;
	let nearest = null,
		distance = Infinity,
		currentAt = null;
	for (const mark of marks) {
		const r = mark.getBoundingClientRect(),
			center = r.top + r.height / 2,
			d = Math.abs(y - center);
		if (Number(mark.dataset.notch) === Number($("mascon").value))
			currentAt = center;
		if (d < distance) {
			distance = d;
			nearest = mark;
		}
	}
	// A small detent prevents a shaky pointer from alternating at a boundary.
	if (currentAt !== null && marks.length > 1) {
		const first = marks[0].getBoundingClientRect(),
			second = marks[1].getBoundingClientRect(),
			spacing = second.top + second.height / 2 - first.top - first.height / 2;
		if (Math.abs(y - currentAt) <= distance + spacing * 0.24) return;
	}
	if (nearest) requestNotch(Number(nearest.dataset.notch));
}
function endMasconDrag() {
	if (!masconDrag) return;
	const pointerId = masconDrag.pointerId;
	masconDrag = null;
	$("notch-scale").classList.remove("dragging");
	if ($("mascon").hasPointerCapture(pointerId))
		$("mascon").releasePointerCapture(pointerId);
}
$("mascon").addEventListener("pointerdown", (e) => {
	if (!owned || !online || e.button !== 0 || masconDrag) return;
	e.preventDefault();
	$("mascon").focus({ preventScroll: true });
	const selected = document.querySelector("#notch-scale span.selected"),
		r = selected.getBoundingClientRect(),
		css = getComputedStyle(selected, "::after"),
		scale = r.width / selected.offsetWidth,
		centerX = r.left + parseFloat(css.left) * scale,
		centerY = r.top + r.height / 2;
	const onHandle =
		Math.abs(e.clientX - centerX) <= parseFloat(css.width) * scale / 2 &&
		Math.abs(e.clientY - centerY) <= parseFloat(css.height) * scale / 2;
	masconDrag = { pointerId: e.pointerId, offsetY: onHandle ? e.clientY - centerY : 0 };
	$("notch-scale").classList.add("dragging");
	$("mascon").setPointerCapture(e.pointerId);
	// Grabbing any part of the handle keeps its notch until the mouse moves.
	if (!onHandle) pointerNotch(e);
});
$("mascon").addEventListener("pointermove", (e) => {
	if (e.pointerId !== masconDrag?.pointerId) return;
	if (masconDrag && e.pointerType === "mouse" && !(e.buttons & 1)) {
		endMasconDrag();
		return;
	}
	pointerNotch(e);
});
$("mascon").addEventListener("pointerup", (e) => {
	if (e.pointerId !== masconDrag?.pointerId) return;
	pointerNotch(e);
	endMasconDrag();
});
for (const event of ["pointercancel", "lostpointercapture"])
	$("mascon").addEventListener(event, (e) => {
		if (e.pointerId === masconDrag?.pointerId) endMasconDrag();
	});
window.addEventListener("blur", endMasconDrag);
$("take-control").addEventListener("click", async () => {
	try {
		await command("acquire");
		// Membership and notch come from ESP32; joining an existing Web drive
		// must not reset it to maximum braking.
		message();
		refreshControls();
	} catch (e) {
		message(e.message);
	}
});
$("release-control").addEventListener("click", async () => {
	try {
		await command("release");
		loseControl();
		message();
	} catch (e) {
		message(e.message);
	}
});
window.addEventListener("keydown", (e) => {
	if (
		waveDialog.open ||
		!owned ||
		["SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
	)
		return;
	const neutral = e.code === "Space" || e.key === " ";
	if (e.key === "ArrowUp" || e.key === "ArrowDown" || neutral) {
		e.preventDefault();
		requestNotch(
			neutral
				? 0
				: Number($("mascon").value) + (e.key === "ArrowDown" ? 1 : -1),
		);
	}
});
window.addEventListener("pagehide", () => bluetooth.close());
let heartbeatPending = false;
setInterval(async () => {
	if (!online || heartbeatPending) return;
	heartbeatPending = true;
	try {
		await command("heartbeat");
	} catch (e) {
		if (e.code === "session") bluetooth.disconnected();
		disconnected();
	} finally {
		heartbeatPending = false;
	}
}, 250);
// A worker timer avoids the normal one-second background-tab timer clamp.
const heartbeatWorker = new Worker("heartbeat.js");
heartbeatWorker.onmessage = () => {
	if (online && !heartbeatPending) {
		heartbeatPending = true;
		command("heartbeat")
			.catch((e) => {
				if (e.code === "session") bluetooth.disconnected();
				disconnected();
			})
			.finally(() => (heartbeatPending = false));
	}
};
const svgNS = "http://www.w3.org/2000/svg";

function resizeSpeedometer() {
	const mobile = mobileLayout.matches,
		meter = $("speedometer"),
		width = mobile ? meter.clientWidth : 628,
		height = mobile ? 160 : 212,
		left = mobile ? 14 : 24,
		top = mobile ? 112 : 140;
	const key = `${mobile}/${width}`;
	if (meterLayoutKey === key) return;
	meterLayoutKey = key;
	meterTravel = width - left * 2;
	meter.setAttribute("viewBox", `0 0 ${width} ${height}`);
	const [face, track] = meter.querySelectorAll("rect");
	face.setAttribute("width", width - 1);
	face.setAttribute("height", height - 1);
	for (const rect of [track, $("speed-fill")]) {
		rect.setAttribute("x", left);
		rect.setAttribute("y", top);
	}
	track.setAttribute("width", meterTravel);
	const position = (Math.max(0, Math.min(160, state?.speed_kmh || 0)) / 160) * meterTravel;
	$("speed-fill").setAttribute("width", position);
	const needle = $("needle");
	needle.setAttribute("transform", `translate(${position} 0)`);
	needle.querySelector("path").setAttribute("d",
		`M${left - 5} ${top - 21} L${left + 5} ${top - 21} L${left} ${top - 11} Z`);
	const needleLine = needle.querySelector("line");
	needleLine.setAttribute("x1", left);
	needleLine.setAttribute("x2", left);
	needleLine.setAttribute("y1", top - 10);
	needleLine.setAttribute("y2", top + 24);
	$("speed-ticks").replaceChildren();
	for (let n = 0; n <= 160; n += 5) {
		const x = left + (n / 160) * meterTravel,
			line = document.createElementNS(svgNS, "line");
		line.setAttribute("x1", x);
		line.setAttribute("x2", x);
		line.setAttribute("y1", top);
		line.setAttribute("y2", top + (n % 20 === 0 ? 24 : n % 10 === 0 ? 17 : 11));
		line.setAttribute("stroke", n % 20 === 0 ? "#eef3f7" : "#9cabb8");
		line.setAttribute("stroke-width", n % 20 === 0 ? 2 : 1);
		$("speed-ticks").append(line);
		if (n % (mobile ? 40 : 20) === 0) {
			const label = document.createElementNS(svgNS, "text");
			label.setAttribute("x", x);
			label.setAttribute("y", mobile ? 153 : 190);
			label.setAttribute("text-anchor", "middle");
			label.setAttribute("fill", "#e2ebf2");
			label.setAttribute("font-size", mobile ? "11" : "15");
			label.textContent = n;
			$("speed-ticks").append(label);
		}
	}
}
resizeSpeedometer();
buildScale(5, 7);
setNotchBadge(-7);
layoutReady = true;
function draw() {
	const ratio = (devicePixelRatio || 1) * layoutScale,
		w = canvas.clientWidth,
		h = canvas.clientHeight;
	if (
		canvas.width !== Math.round(w * ratio) ||
		canvas.height !== Math.round(h * ratio)
	) {
		canvas.width = Math.round(w * ratio);
		canvas.height = Math.round(h * ratio);
		waveDirty = true;
	}
	if (waveDirty) {
		waveDirty = false;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const zeroY = waveformY(0, h);
		ctx.strokeStyle = "rgba(153, 153, 153, 0.5)";
		ctx.lineWidth = 1.5;
		ctx.setLineDash([7, 6]);
		ctx.beginPath();
		ctx.moveTo(0, zeroY);
		ctx.lineTo(w, zeroY);
		ctx.stroke();
		ctx.setLineDash([]);
		if (online && frame?.samples.length) {
			ctx.strokeStyle = darkTheme.matches ? "#e8e8e8" : "#111";
			ctx.lineWidth = 1.95;
			ctx.lineJoin = "round";
			ctx.beginPath();
			ctx.moveTo(0, waveformY(frame.samples[0], h));
			const xScale = w / frame.sampleSpan;
			if (frame.sampleOffset > 0)
				ctx.lineTo(frame.sampleOffset * xScale, waveformY(frame.samples[0], h));
			for (let i = 1; i < frame.samples.length; ++i) {
				ctx.lineTo((i + frame.sampleOffset) * xScale, waveformY(frame.samples[i], h));
			}
			if ((frame.samples.length - 1 + frame.sampleOffset) < frame.sampleSpan)
				ctx.lineTo(w, waveformY(frame.samples[frame.samples.length - 1], h));
			ctx.stroke();
		}
	}
	if (owned && performance.now() - lastStateAt > 1500) disconnected();
	requestAnimationFrame(draw);
}
$("connect-device").addEventListener("click", async () => {
	$("connect-device").disabled = true;
	try {
		await bluetooth.connect();
		message();
	} catch (e) {
		message(e.message);
	} finally {
		$("connect-device").disabled = false;
	}
});
void pollState();
requestAnimationFrame(draw);
