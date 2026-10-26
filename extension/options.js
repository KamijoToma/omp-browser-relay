// Options page for the OMP Browser Relay extension (plain JS: shipped as-is).
const DEFAULT_PORT = 9224;
const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.local.get({ port: DEFAULT_PORT, token: "" }).then(stored => {
	portInput.value = String(stored.port);
	tokenInput.value = String(stored.token);
});

document.getElementById("save").addEventListener("click", async () => {
	const port = Number(portInput.value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		status.textContent = "invalid port";
		return;
	}
	await chrome.storage.local.set({ port, token: tokenInput.value });
	status.textContent = "saved";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
});

const createWorkTab = document.getElementById("create-work-tab");
const workspaceStatus = document.getElementById("workspace-status");
createWorkTab.addEventListener("click", async () => {
	createWorkTab.disabled = true;
	try {
		const response = await chrome.runtime.sendMessage({ op: "createWorkspaceTab" });
		if (response?.ok !== true) throw new Error(response?.error ?? "Workspace creation failed");
		workspaceStatus.textContent = "Background work tab created. You can now connect omp.";
	} catch (error) {
		workspaceStatus.textContent = error instanceof Error ? error.message : String(error);
	} finally {
		createWorkTab.disabled = false;
	}
});

const tailnetToggle = document.getElementById("tailnet-enabled");
const tailnetStatus = document.getElementById("tailnet-status");
const tailnetAddress = document.getElementById("tailnet-address");
const tailnetAddresses = document.getElementById("tailnet-addresses");
const tailnetCommand = document.getElementById("tailnet-command");
const copyTailnetCommand = document.getElementById("copy-tailnet-command");
let tailnetPort = DEFAULT_PORT;
let detectedTailnetAddresses = [];
function isTailnetIpv4(address) {
	const octets = address.split(".");
	if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet))) return false;
	const [first, second, third, fourth] = octets.map(Number);
	return first === 100 && second >= 64 && second <= 127 && third <= 255 && fourth <= 255;
}

function markTailnetStateUnknown(message) {
	tailnetToggle.checked = false;
	tailnetToggle.indeterminate = true;
	tailnetToggle.disabled = true;
	tailnetAddress.disabled = true;
	tailnetPort = 0;
	updateTailnetCommand();
	tailnetStatus.textContent = message;
}

function updateTailnetCommand() {
	const address = tailnetAddress.value;
	if (!address || !tailnetPort) {
		tailnetCommand.textContent = "No Tailscale address detected.";
		copyTailnetCommand.disabled = true;
		return;
	}
	tailnetCommand.textContent = `omp config set browser.relayUrl http://${address}:${tailnetPort}`;
	copyTailnetCommand.disabled = false;
}

function applyTailnetResult(result) {
	if (
		!result ||
		typeof result.enabled !== "boolean" ||
		!Number.isInteger(result.port) ||
		result.port < 1 ||
		result.port > 65535 ||
		!Array.isArray(result.tailnetAddresses)
	) {
		markTailnetStateUnknown(result?.error ?? "Unable to read Tailscale access status.");
		return false;
	}
	detectedTailnetAddresses = result.tailnetAddresses.filter(
		address => typeof address === "string" && isTailnetIpv4(address),
	);
	tailnetPort = result.port;
	tailnetAddress.replaceChildren();
	for (const address of detectedTailnetAddresses) {
		const option = document.createElement("option");
		option.value = address;
		option.textContent = address;
		tailnetAddress.append(option);
	}
	tailnetAddresses.textContent = detectedTailnetAddresses.length
		? `Detected addresses: ${detectedTailnetAddresses.join(", ")}`
		: "No Tailscale IPv4 addresses detected on this machine.";
	tailnetToggle.checked = result.enabled;
	tailnetToggle.indeterminate = false;
	tailnetToggle.disabled = detectedTailnetAddresses.length === 0 && !result.enabled;
	tailnetAddress.disabled = detectedTailnetAddresses.length === 0;
	tailnetStatus.textContent =
		result.ok === false
			? (result.error ?? "Tailnet access update failed.")
			: detectedTailnetAddresses.length
				? result.enabled
					? "Remote Tailscale access is enabled."
					: "Remote Tailscale access is disabled."
				: result.enabled
					? "Remote access is enabled, but this machine has no detected Tailscale IPv4 address."
					: "Remote access is unavailable until a Tailscale IPv4 address is detected.";
	updateTailnetCommand();
	return result.ok === true;
}

chrome.runtime
	.sendMessage({ op: "getTailnetAccess" })
	.then(result => {
		applyTailnetResult(result);
	})
	.catch(error => {
		markTailnetStateUnknown(error instanceof Error ? error.message : String(error));
	});

tailnetToggle.addEventListener("change", async () => {
	const enabled = tailnetToggle.checked;
	tailnetToggle.disabled = true;
	tailnetStatus.textContent = "Updating Tailscale access…";
	try {
		const result = await chrome.runtime.sendMessage({ op: "setTailnetAccess", enabled });
		applyTailnetResult(result);
	} catch (error) {
		markTailnetStateUnknown(
			`Could not confirm the current access state. Reconnect the relay and reopen settings. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
});

tailnetAddress.addEventListener("change", updateTailnetCommand);
copyTailnetCommand.addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(tailnetCommand.textContent);
		tailnetStatus.textContent = "Remote connection command copied.";
	} catch (error) {
		tailnetStatus.textContent = error instanceof Error ? error.message : String(error);
	}
});
