import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir, getAgentDbPath } from "@oh-my-pi/pi-utils";

/**
 * Startup opens `agent.db` once for settings. Credential discovery used to open a
 * second connection to the same file (plus a second schema pass) while the first
 * frame was already painted but the app still could not accept input. These cases
 * pin that discovery adopts the connection settings already holds — and that it
 * never closes a connection it does not own.
 */
describe("discoverAuthStorage reuses the settings agent.db connection", () => {
	let tempDir: TempDir | undefined;
	let spies: Array<{ mockRestore: () => void }> = [];

	afterEach(() => {
		for (const spy of spies) spy.mockRestore();
		spies = [];
		AgentStorage.close();
		if (tempDir) {
			try {
				tempDir.removeSync();
			} catch {}
			tempDir = undefined;
		}
	});

	function agentDir(): string {
		tempDir = TempDir.createSync("@omp-shared-agent-db-");
		return tempDir.path();
	}

	function watchCredentialStoreOpens() {
		const spy = spyOn(SqliteAuthCredentialStore, "open");
		spies.push(spy);
		return spy;
	}

	it("adopts the store behind the settings connection", async () => {
		const dir = agentDir();
		const storage = await AgentStorage.open(getAgentDbPath(dir));
		const settings = Settings.isolated({}, { storage });
		expect(settings.getStorage()?.dbPath).toBe(getAgentDbPath(dir));

		const opened = watchCredentialStoreOpens();
		const authStorage = await discoverAuthStorage(dir, { settings });
		// A second handle means a second WAL open plus a second schema pass, on the
		// path between the painted frame and an app that accepts input.
		expect(opened).not.toHaveBeenCalled();
		// The adopted store is live: a write through its owner is visible here.
		await storage.authStore.upsertAuthCredential("shared-store", { type: "api_key", key: "sk-shared" });
		await authStorage.credentials.reload();
		expect(authStorage.credentials.get("shared-store")).toEqual({ type: "api_key", key: "sk-shared" });
	});

	it("leaves the adopted connection open when the AuthStorage retires the store", async () => {
		const dir = agentDir();
		const storage = await AgentStorage.open(getAgentDbPath(dir));
		const settings = Settings.isolated({}, { storage });
		await storage.authStore.upsertAuthCredential("before-swap", { type: "api_key", key: "sk-before" });

		const authStorage = await discoverAuthStorage(dir, { settings });
		// The live broker-url change path: the retired pool used to close the store
		// it was handed, which would pull agent.db out from under settings.
		await authStorage.replaceStore(await SqliteAuthCredentialStore.open(path.join(dir, "other.db")));

		await storage.authStore.upsertAuthCredential("after-swap", { type: "api_key", key: "sk-after" });
		expect(storage.authStore.listAuthCredentials("after-swap")).toHaveLength(1);
		expect(storage.authStore.listAuthCredentials("before-swap")).toHaveLength(1);
	});

	it("opens its own store when settings hold no storage", async () => {
		const dir = agentDir();
		const opened = watchCredentialStoreOpens();
		await discoverAuthStorage(dir, { settings: Settings.isolated() });
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it("opens its own store when settings storage is a different database", async () => {
		const dir = agentDir();
		const storage = await AgentStorage.open(path.join(dir, "elsewhere.db"));
		const opened = watchCredentialStoreOpens();
		await discoverAuthStorage(dir, { settings: Settings.isolated({}, { storage }) });
		expect(opened).toHaveBeenCalledTimes(1);
	});
});
