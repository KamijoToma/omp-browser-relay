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
