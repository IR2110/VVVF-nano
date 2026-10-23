const favicon = document.querySelector('link[rel="icon"]');
const theme = matchMedia("(prefers-color-scheme: dark)");
const icon = new Image();
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 64;
const ctx = canvas.getContext("2d");

function updateIcon() {
	if (!icon.naturalWidth) return;
	const scale = canvas.width / Math.max(icon.naturalWidth, icon.naturalHeight);
	const width = icon.naturalWidth * scale;
	const height = icon.naturalHeight * scale;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.globalCompositeOperation = "source-over";
	ctx.drawImage(icon, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
	// Keep the source alpha, including the transparent background and cutout.
	ctx.globalCompositeOperation = "source-in";
	ctx.fillStyle = theme.matches ? "#fff" : "#000";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	favicon.href = canvas.toDataURL("image/png");
}

icon.addEventListener("load", updateIcon);
theme.addEventListener("change", updateIcon);
icon.src = "assets/icon.png";
