window.__ModuleLoader__.load({
	id: "dsh-mcp-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/**
		 * dsh-mcp-hub · 浏览器半：设置里的「MCP 工具」一键部署页
		 *
		 * 数据全部来自宿主插件的 /mcp-hub/api/*：
		 *   overview / search / describe / install / action
		 * 组件刻意不依赖任何内部 store：只用 React + fetch，所以升级 DSH 也不容易碎。
		 */
		const API_BASE = "/mcp-hub/api";

		/** 与后端通信；后端离线时给出可读错误而不是抛异常。 */
		async function call(path, options) {
			try {
				const response = await fetch(API_BASE + path, options);
				const text = await response.text();
				let payload = null;
				try {
					payload = JSON.parse(text);
				} catch {
					return { ok: false, error: "宿主返回了非 JSON 内容（" + response.status + "）：" + text.slice(0, 200) };
				}
				return payload;
			} catch (error) {
				return { ok: false, error: String(error && error.message ? error.message : error) };
			}
		}

		const getOverview = () => call("/overview");
		const search = (q, sources) => call("/search?q=" + encodeURIComponent(q) + (sources ? "&sources=" + encodeURIComponent(sources) : ""));
		const describe = (id) => call("/describe?id=" + encodeURIComponent(id));
		const install = (body) => call("/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const action = (body) => call("/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const getDoctor = () => call("/doctor");

		/** 常见场景：一键装好一套，不用懂 MCP。 */
		const SCENARIOS = [
			{ id: "内置全家桶", label: "内置工具包", desc: "零依赖的 files / util / kb / net / hub，离线可用", action: { kind: "catalog", name: "files" } },
			{ id: "记忆", label: "长期记忆", desc: "官方 Memory：跨会话知识图谱", action: { kind: "catalog", name: "mcp-memory" } },
			{ id: "结构思考", label: "结构化思考", desc: "官方 Sequential Thinking：多步推理", action: { kind: "catalog", name: "mcp-thinking" } },
			{ id: "浏览器", label: "浏览器自动化", desc: "Playwright：导航、点击、截图", action: { kind: "catalog", name: "mcp-playwright" } },
			{ id: "数据库", label: "数据库", desc: "官方 SQLite：查询本地 .db 文件", action: { kind: "catalog", name: "mcp-sqlite" } },
			{ id: "文档", label: "库文档检索", desc: "Context7：按库名取最新文档", action: { kind: "catalog", name: "mcp-context7" } },
		];

		const CANDIDATE_SOURCES = [
			{ id: "registry", label: "官方 Registry" },
			{ id: "npm", label: "npm" },
			{ id: "github", label: "GitHub" },
		];


		/** 终端里会被拒绝的典型危险命令（只用于界面提示）。 */
		const DANGER_EXAMPLES = {
			Windows: "format / diskpart / reg delete HKLM / rd /s /q 系统盘 / Remove-Item -Recurse 系统盘",
			posix: "mkfs / dd of=/dev / mount / reboot",
		};

		/** 权限模式：与宿主 permission.js 一一对应。 */
		const PERMISSION_MODES = [
			{ mode: "always", label: "永久启用（不再询问）" },
			{ mode: "session", label: "本会话启用（问一次）" },
			{ mode: "ask", label: "使用时询问" },
			{ mode: "disabled", label: "禁用（直接拒绝）" },
		];

		/** 小工具：拼 className。 */
		function cx() {
			const parts = [];
			for (let index = 0; index < arguments.length; index += 1) {
				const value = arguments[index];
				if (value === undefined || value === null || value === false || value === "") continue;
				parts.push(String(value));
			}
			return parts.join(" ");
		}

		function textOf(value, fallback) {
			return value === undefined || value === null || value === "" ? (fallback === undefined ? "" : fallback) : String(value);
		}

		/** 状态点：绿=运行中，黄=未连接，灰=停用。 */
		function StatusDot(props) {
			const className = props.state === "running" ? "dshMcpHub_dotOk" : (props.state === "disabled" ? "dshMcpHub_dotOff" : "dshMcpHub_dotWarn");
			return react.createElement("span", { className: cx("dshMcpHub_dot", className), title: props.title || props.state }, null);
		}

		/** 重叠/核验提示条。 */
		function OverlapNote(props) {
			const overlap = props.overlap;
			if (overlap === undefined || overlap === null || overlap.level === "none") {
				if (props.verification !== undefined && props.verification !== null && props.verification.exists === false) {
					return react.createElement("p", { className: "dshMcpHub_warn" }, "npm 上找不到这个包，安装大概率会失败");
				}
				return null;
			}
			const className = overlap.level === "high" ? "dshMcpHub_warn" : (overlap.level === "medium" ? "dshMcpHub_hint" : "dshMcpHub_dim");
			const hits = Array.isArray(overlap.hits) ? overlap.hits : [];
			const advice = hits.length > 0 && hits[0].advice ? hits[0].advice : "";
			return react.createElement("p", { className }, overlap.summary + (advice === "" ? "" : "。" + advice));
		}

		/** 一个已装服务的卡片。 */
		function InstalledCard(props) {
			const item = props.item;
			const busy = props.busyName === item.name;
			const [open, setOpen] = react.useState(false);
			const tools = Array.isArray(item.tools) ? item.tools : [];
			return react.createElement("li", { className: "dshMcpHub_card" },
				react.createElement("div", { className: "dshMcpHub_rowHead" },
					react.createElement(StatusDot, { state: item.state, title: item.state }),
					react.createElement("span", { className: "dshMcpHub_cardTitle" }, textOf(item.label, item.name)),
					react.createElement("span", { className: "dshMcpHub_tag" }, item.name),
					item.builtin === true ? react.createElement("span", { className: "dshMcpHub_tagGood" }, "内置") : null,
					react.createElement("span", { className: "dshMcpHub_meta" }, item.state === "running" ? (item.toolCount + " 个工具") : (item.state === "disabled" ? "已停用" : "未连接")),
					react.createElement("span", { className: "dshMcpHub_spacer" }),
					react.createElement("button", { className: "dshMcpHub_btn", disabled: busy, onClick: () => props.onAction("test", item.name) }, "测试"),
					item.enabled === false
						? react.createElement("button", { className: "dshMcpHub_btnPrimary", disabled: busy, onClick: () => props.onAction("enable", item.name) }, "启用")
						: react.createElement("button", { className: "dshMcpHub_btn", disabled: busy, onClick: () => props.onAction("disable", item.name) }, "停用"),
					react.createElement("button", { className: "dshMcpHub_btnDanger", disabled: busy, onClick: () => props.onAction("remove", item.name) }, "卸载")
				),
				item.description ? react.createElement("p", { className: "dshMcpHub_desc" }, item.description) : null,
				react.createElement(OverlapNote, { overlap: item.overlap }),
				react.createElement("div", { className: "dshMcpHub_permRow" },
					react.createElement("span", { className: "dshMcpHub_fieldLabel" }, "调用权限"),
					react.createElement("select", {
						className: "dshMcpHub_select",
						value: item.permission || "always",
						disabled: busy,
						onChange: (event) => props.onPermission(item.name, event.target.value),
					}, PERMISSION_MODES.map((mode) => react.createElement("option", { key: mode.mode, value: mode.mode }, mode.label))),
					react.createElement("span", { className: "dshMcpHub_dim" }, item.permission === "ask" || item.permission === "session" ? "调用时会走 DSH 审批弹窗" : (item.permission === "disabled" ? "调用一律被拒" : "不再询问"))
				),
				react.createElement("p", { className: "dshMcpHub_cmd" }, item.command),
				tools.length > 0 ? react.createElement("div", null,
					react.createElement("button", { className: "dshMcpHub_link", onClick: () => setOpen(!open) }, open ? "收起工具（" + tools.length + "）" : "查看工具（" + tools.length + "）"),
					open ? react.createElement("div", { className: "dshMcpHub_toolList" }, tools.map((name) => react.createElement("code", { key: name, className: "dshMcpHub_toolChip" }, name))) : null
				) : null,
				item.result !== null && item.result !== "running" && item.result !== "disabled" ? react.createElement("p", { className: "dshMcpHub_dim" }, "上次结果：" + String(item.result)) : null
			);
		}


		/** 目录条目卡片：一键安装。 */
		function CatalogCard(props) {
			const item = props.item;
			const busy = props.busyName === item.name;
			const missing = Array.isArray(item.runnerMissing) ? item.runnerMissing : [];
			const unsupported = item.supported === false;
			const blocked = unsupported || missing.length > 0;
			const label = item.installed === true ? "已装" : (unsupported ? "平台不支持" : (missing.length > 0 ? "缺运行器" : "一键安装"));
			return react.createElement("li", { className: cx("dshMcpHub_card", unsupported ? "dshMcpHub_cardMuted" : null) },
				react.createElement("div", { className: "dshMcpHub_rowHead" },
					react.createElement("span", { className: "dshMcpHub_cardTitle" }, textOf(item.label, item.name)),
					item.builtin === true ? react.createElement("span", { className: "dshMcpHub_tagGood" }, "内置") : null,
					item.mobileOnly === true ? react.createElement("span", { className: "dshMcpHub_tag" }, "手机专属") : null,
					item.installed === true ? react.createElement("span", { className: "dshMcpHub_tag" }, "已安装") : null,
					react.createElement("span", { className: "dshMcpHub_spacer" }),
					react.createElement("button", { className: "dshMcpHub_btnPrimary", disabled: busy || item.installed === true || blocked, onClick: () => props.onInstall({ mode: "catalog", catalogName: item.name, name: props.name }) }, label)
				),
				item.description ? react.createElement("p", { className: "dshMcpHub_desc" }, item.description) : null,
				react.createElement("p", { className: "dshMcpHub_cmd" }, item.command),
				Array.isArray(item.requires) && item.requires.length > 0 ? react.createElement("p", { className: "dshMcpHub_dim" }, "需要：" + item.requires.join("；")) : null,
				missing.length > 0 ? react.createElement("p", { className: "dshMcpHub_warn" }, "缺 " + missing.map((row) => row.label).join("、") + "，先装：") : null,
				missing.map((row) => react.createElement("code", { key: row.id, className: "dshMcpHub_toolChip" }, row.installHint))
			);
		}

		/** 在线候选卡片。 */
		function CandidateCard(props) {
			const item = props.item;
			const busy = props.busyName === item.id;
			const [detail, setDetail] = react.useState(null);
			const pkg = Array.isArray(item.packages) && item.packages.length > 0 ? item.packages[0] : null;
			const remote = Array.isArray(item.remotes) && item.remotes.length > 0 ? item.remotes[0] : null;
			const how = pkg !== null ? ((pkg.runtimeHint || "npx") + " " + pkg.identifier) : (remote !== null ? remote.url : "（仅线索，需要自己给启动命令）");
			return react.createElement("li", { className: "dshMcpHub_card" },
				react.createElement("div", { className: "dshMcpHub_rowHead" },
					react.createElement("span", { className: "dshMcpHub_tag" }, item.source === "registry" ? "官方 Registry" : item.source),
					typeof item.stars === "number" && item.stars > 0 ? react.createElement("span", { className: "dshMcpHub_tag" }, "★ " + item.stars) : null,
					react.createElement("span", { className: "dshMcpHub_cardTitle" }, textOf(item.title, item.name)),
					item.installed === true ? react.createElement("span", { className: "dshMcpHub_tagGood" }, "已安装") : null,
					react.createElement("span", { className: "dshMcpHub_spacer" }),
					react.createElement("button", { className: "dshMcpHub_btn", disabled: busy, onClick: () => props.onDescribe(item.id).then(setDetail) }, "详情"),
					react.createElement("button", { className: "dshMcpHub_btnPrimary", disabled: busy || item.installable === false || item.installed === true, onClick: () => props.onInstall({ mode: "online", id: item.id }) }, item.installed === true ? "已装" : (item.installable === false ? "不可直装" : "一键安装"))
				),
				react.createElement("p", { className: "dshMcpHub_cmd" }, item.id),
				item.description ? react.createElement("p", { className: "dshMcpHub_desc" }, item.description) : null,
				react.createElement("p", { className: "dshMcpHub_cmd" }, how),
				react.createElement(OverlapNote, { overlap: item.overlap, verification: item.verification }),
				item.verification !== null && item.verification !== undefined && item.verification.exists === true
					? react.createElement("p", { className: "dshMcpHub_dim" }, "npm 包 " + item.verification.identifier + "@" + textOf(item.verification.latest, "?") + (typeof item.verification.downloadsLastMonth === "number" ? "（月下载 " + item.verification.downloadsLastMonth + "）" : ""))
					: null,
				item.note ? react.createElement("p", { className: "dshMcpHub_dim" }, item.note) : null,
				detail !== null && detail !== undefined && detail.ok === true
					? react.createElement("div", { className: "dshMcpHub_detail" },
						detail.installSuggestion !== undefined && detail.installSuggestion !== null
							? react.createElement("p", { className: "dshMcpHub_cmd" }, "建议启动：" + (detail.installSuggestion.transport === "stdio" ? [detail.installSuggestion.command, ...(detail.installSuggestion.args || [])].join(" ") : detail.installSuggestion.url))
							: null,
						Array.isArray(detail.installSuggestion !== undefined && detail.installSuggestion !== null && detail.installSuggestion.requires) && detail.installSuggestion.requires.length > 0
							? react.createElement("p", { className: "dshMcpHub_hint" }, detail.installSuggestion.requires.join("；"))
							: null
					)
					: null
			);
		}


		/** 设置页主体。 */
		function McpHubSection() {
			const [overview, setOverview] = react.useState(null);
			const [error, setError] = react.useState("");
			const [notice, setNotice] = react.useState("");
			const [busy, setBusy] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [sources, setSources] = react.useState(["registry", "npm"]);
			const [results, setResults] = react.useState(null);
			const [catalogOpen, setCatalogOpen] = react.useState(false);
			const [customOpen, setCustomOpen] = react.useState(false);
			const [custom, setCustom] = react.useState({ name: "", transport: "stdio", command: "npx", args: "", env: "", url: "" });
			const [native, setNative] = react.useState(null);
			const [doctor, setDoctor] = react.useState(null);
			const [terminalId, setTerminalId] = react.useState(null);
			const [terminalOut, setTerminalOut] = react.useState("");
			const [terminalInput, setTerminalInput] = react.useState("");
			const cursorRef = react.useRef ? react.useRef(0) : { current: 0 };

			const load = react.useCallback(async () => {
				const payload = await getOverview();
				if (payload.ok === false) setError(payload.error);
				else { setError(""); setOverview(payload); }
			}, []);

			react.useEffect(() => { load(); }, [load]);

			async function runInstall(body) {
				setBusy("install:" + (body.name || body.id || body.catalogName || ""));
				setNotice("");
				try {
					const payload = await install(body);
					if (payload.ok === false) { setError(payload.error); return; }
					const failed = Array.isArray(payload.failed) ? payload.failed : [];
					setNotice(failed.length === 0
						? "已安装并挂载：" + payload.target
						: "已写入注册表，但启动失败：" + failed.map((item) => item.name + "（" + item.error + "）").join("；"));
					if (failed.length > 0) setError(failed.map((item) => item.name + "：" + item.error).join("\n"));
					await load();
				} finally {
					setBusy("");
				}
			}

			async function runAction(name, target) {
				setBusy(target + ":" + name);
				setNotice("");
				try {
					const payload = await action({ action: name, name: target });
					if (payload.ok === false) { setError(payload.error); return; }
					if (name === "test") {
						setNotice("探测 " + target + "：发现 " + payload.probe.toolCount + " 个工具（" + payload.probe.tools.slice(0, 8).map((item) => item.rawName).join("、") + "）");
					} else if (name === "remove") setNotice("已卸载：" + target);
					else setNotice((name === "enable" ? "已启用：" : "已停用：") + target);
					if (name !== "test") await load();
				} finally {
					setBusy("");
				}
			}

			/** 环境体检：一次点按拿到「缺什么 + 怎么修」。 */
			async function runDoctor() {
				setBusy("doctor");
				setError("");
				try {
					const payload = await call("/doctor");
					if (payload.ok === false && payload.items === undefined) { setError(payload.error || "体检失败"); return; }
					setDoctor(payload);
					setNotice("体检：" + payload.summary);
				} finally {
					setBusy("");
				}
			}

			async function runPermission(name, mode) {
				setBusy("perm:" + name);
				try {
					const payload = await call("/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mode }) });
					if (payload.ok === false) { setError(payload.error); return; }
					setNotice("权限已更新：" + name + " → " + mode);
					await load();
				} finally {
					setBusy("");
				}
			}

			/** 终端：把一条命令送进宿主 shell，然后轮询增量输出。 */
			async function terminalRun() {
				const command = terminalInput;
				if (command.trim() === "") return;
				setTerminalInput("");
				setTerminalOut((current) => current + "$ " + command + "\n");
				const payload = await call("/terminal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run", id: terminalId, command }) });
				if (payload.ok === false) {
					setTerminalOut((current) => current + "[错误] " + payload.error + "\n");
					return;
				}
				if (payload.id !== undefined && payload.id !== terminalId) {
					setTerminalId(payload.id);
					cursorRef.current = 0;
				}
			}

			// 终端输出轮询：有会话就每 700ms 拉一次增量
			react.useEffect(() => {
				if (terminalId === null) return undefined;
				let alive = true;
				const timer = setInterval(async () => {
					if (!alive) return;
					const url = "/terminal?id=" + encodeURIComponent(terminalId) + "&cursor=" + String(cursorRef.current);
					const payload = await call(url);
					if (!alive || payload === null || payload.ok === false) return;
					if (typeof payload.output === "string" && payload.output !== "") {
						setTerminalOut((current) => (current + payload.output).slice(-40000));
					}
					if (typeof payload.cursor === "number") cursorRef.current = payload.cursor;
				}, 700);
				return () => { alive = false; clearInterval(timer); };
			}, [terminalId]);

			async function runSearch() {
				if (query.trim() === "") return;
				setBusy("search");
				setError("");
				try {
					const payload = await search(query.trim(), sources.join(","));
					if (payload.ok === false) { setError(payload.error); setResults([]); return; }
					setResults(payload.results || []);
					setNative(Array.isArray(payload.native) ? payload.native : []);
					if (Array.isArray(payload.notes) && payload.notes.length > 0) setNotice(payload.notes.filter((item) => item !== "").join("；"));
				} finally {
					setBusy("");
				}
			}

			function toggleSource(id) {
				setSources((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
			}

			const installed = overview !== null && Array.isArray(overview.installed) ? overview.installed : [];
			const catalog = overview !== null && Array.isArray(overview.catalog) ? overview.catalog : [];
			const builtinCatalog = catalog.filter((item) => item.builtin === true);
			const externalCatalog = catalog.filter((item) => item.builtin !== true);
			const installedNames = new Set(installed.map((item) => item.name));
			const counts = overview !== null && overview.counts ? overview.counts : { installed: 0, running: 0, tools: 0, catalog: 0 };

			return react.createElement("div", { className: "dshMcpHub_section" },
				react.createElement("h2", { className: "dshMcpHub_title" }, "MCP 工具"),
				react.createElement("p", { className: "dshMcpHub_intro" }, "一键部署 MCP 服务与工具：内置零依赖工具包离线可用，也可以从官方 MCP Registry / npm / GitHub 搜索后一键安装。安装即挂载，不用重启 DSH。"),
				error !== "" ? react.createElement("pre", { className: "dshMcpHub_error" }, error) : null,
				notice !== "" ? react.createElement("p", { className: "dshMcpHub_notice" }, notice) : null,
				overview === null
					? react.createElement("p", { className: "dshMcpHub_dim" }, "正在读取 MCP Hub 状态…（若一直没反应，说明宿主插件未加载）")
					: react.createElement("div", { className: "dshMcpHub_stats" },
						react.createElement("span", null, "已装 " + counts.installed),
						react.createElement("span", null, "运行中 " + counts.running),
						react.createElement("span", null, "工具 " + counts.tools),
						react.createElement("span", null, "目录 " + counts.catalog),
						overview.platform !== undefined ? react.createElement("span", { className: "dshMcpHub_tag" }, overview.platform.label + (overview.platform.mobileDsha === true ? " · DSH 安卓" : "")) : null,
						react.createElement("span", { className: "dshMcpHub_spacer" }),
						react.createElement("button", { className: "dshMcpHub_btnPrimary", onClick: runDoctor, disabled: busy !== "" }, busy === "doctor" ? "体检中…" : "环境体检"),
						react.createElement("button", { className: "dshMcpHub_btn", onClick: () => runAction("reload", "") , disabled: busy !== "" }, "重新同步"),
						react.createElement("button", { className: "dshMcpHub_btn", onClick: load, disabled: busy !== "" }, "刷新")
					),

				// 缺运行器是桌面用户最常见的第一次失败原因：直接顶到最上面，带安装命令。
				overview !== null && Array.isArray(overview.runners) && overview.platform !== undefined && overview.platform.mobileDsha !== true && overview.runners.some((row) => row.available !== true && row.id !== "git")
					? react.createElement("div", { className: "dshMcpHub_docBox" }, overview.runners.filter((row) => row.available !== true && row.id !== "git").map((row) => react.createElement("p", { key: row.id, className: "dshMcpHub_warn" },
						"缺少 " + row.label + "：" + row.why + "　→　" + row.installHint)))
					: null,

				doctor !== null && doctor.counts !== undefined ? react.createElement("div", { className: "dshMcpHub_docBox" },
					react.createElement("div", { className: "dshMcpHub_rowHead" },
						react.createElement("h3", { className: "dshMcpHub_h3" }, "体检报告"),
						react.createElement("span", { className: "dshMcpHub_dim" }, doctor.summary + "（错 " + doctor.counts.errors + " · 提醒 " + doctor.counts.warns + " · 通过 " + doctor.counts.ok + "）"),
						react.createElement("span", { className: "dshMcpHub_spacer" }),
						react.createElement("button", { className: "dshMcpHub_link", onClick: () => setDoctor(null) }, "关闭")
					),
					react.createElement("ul", { className: "dshMcpHub_docList" }, doctor.items.map((item) => react.createElement("li", { key: item.id, className: item.level === "error" ? "dshMcpHub_warn" : (item.level === "warn" ? "dshMcpHub_hint" : "dshMcpHub_dim") },
						(item.level === "ok" ? "✓ " : (item.level === "warn" ? "! " : "✗ ")) + item.title + "：" + item.detail,
						item.fix !== null ? react.createElement("code", { className: "dshMcpHub_toolChip" }, item.fix) : null
					)))
				) : null,

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("h3", { className: "dshMcpHub_h3" }, "常用场景（一键装）"),
					react.createElement("div", { className: "dshMcpHub_scenarios" }, SCENARIOS.map((scenario) => react.createElement("button", {
						key: scenario.id,
						className: "dshMcpHub_scenario",
						disabled: busy !== "" || installedNames.has(scenario.action.name),
						onClick: () => runInstall({ mode: "catalog", catalogName: scenario.action.name }),
					},
						react.createElement("span", { className: "dshMcpHub_scenarioLabel" }, installedNames.has(scenario.action.name) ? scenario.label + " · 已装" : scenario.label),
						react.createElement("span", { className: "dshMcpHub_scenarioDesc" }, scenario.desc)
					)).concat([
						react.createElement("button", {
							key: "advanced",
							className: "dshMcpHub_scenario dshMcpHub_scenarioAdvanced",
							onClick: () => { setCustomOpen(true); setCatalogOpen(true); },
						},
							react.createElement("span", { className: "dshMcpHub_scenarioLabel" }, "高级：自定义 MCP"),
							react.createElement("span", { className: "dshMcpHub_scenarioDesc" }, "自己给命令/参数/环境变量/远程地址，或从目录里挑")
						)
					]))
				),

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("h3", { className: "dshMcpHub_h3" }, "智能搜索（按需装，不预先全量加载）"),
					react.createElement("div", { className: "dshMcpHub_searchRow" },
						react.createElement("input", {
							className: "dshMcpHub_input",
							placeholder: "例如 github、postgres、网页抓取、浏览器…",
							value: query,
							onChange: (event) => setQuery(event.target.value),
							onKeyDown: (event) => { if (event.key === "Enter") runSearch(); },
						}),
						react.createElement("button", { className: "dshMcpHub_btnPrimary", onClick: runSearch, disabled: busy !== "" }, busy === "search" ? "搜索中…" : "搜索")
					),
					react.createElement("div", { className: "dshMcpHub_sourceRow" }, CANDIDATE_SOURCES.map((source) => react.createElement("label", { key: source.id, className: "dshMcpHub_check" },
						react.createElement("input", { type: "checkbox", checked: sources.includes(source.id), onChange: () => toggleSource(source.id) }),
						" " + source.label
					)), react.createElement("span", { className: "dshMcpHub_dim" }, "结果会自动标注与 DSH 内置能力重叠的项，重叠的排在后面并给出提醒")),
					results === null ? null : react.createElement("div", null,
						Array.isArray(native) && native.length > 0 ? react.createElement("div", { className: "dshMcpHub_nativeBox" },
							react.createElement("p", { className: "dshMcpHub_dim" }, "DSH 原生工具命中 " + native.length + " 个（无需安装，已经可用）："),
							react.createElement("div", { className: "dshMcpHub_nativeList" }, native.map((tool) => react.createElement("div", { key: tool.id, className: "dshMcpHub_nativeItem" },
								react.createElement("span", { className: "dshMcpHub_tagGood" }, "原生"),
								react.createElement("span", { className: "dshMcpHub_cardTitle" }, tool.title),
								react.createElement("code", { className: "dshMcpHub_cmd" }, tool.name),
								react.createElement("span", { className: "dshMcpHub_dim" }, tool.description)
							)))
						) : null,
						react.createElement("p", { className: "dshMcpHub_dim" }, "在线命中 " + results.length + " 条"),
						results.length === 0
							? react.createElement("p", { className: "dshMcpHub_dim" }, "没有可安装的结果。换个关键词，或把 GitHub 也勾上。")
							: react.createElement("ul", { className: "dshMcpHub_list" }, results.map((item) => react.createElement(CandidateCard, { key: item.source + ":" + item.id, item, busyName: busy, onInstall: runInstall, onDescribe: describe })))
					)
				),

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("h3", { className: "dshMcpHub_h3" }, "已装服务（" + installed.length + "）"),
					installed.length === 0
						? react.createElement("p", { className: "dshMcpHub_dim" }, "还没有安装任何 MCP 服务。上面点一个「常用场景」就能装好。")
						: react.createElement("ul", { className: "dshMcpHub_list" }, installed.map((item) => react.createElement(InstalledCard, { key: item.name, item, busyName: busy, onAction: runAction, onPermission: runPermission })))
				),

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("div", { className: "dshMcpHub_rowHead" },
						react.createElement("h3", { className: "dshMcpHub_h3" }, "内置终端"),
						react.createElement("span", { className: "dshMcpHub_dim" }, terminalId === null ? "尚未连接" : ("会话 " + terminalId)),
						react.createElement("span", { className: "dshMcpHub_spacer" }),
						react.createElement("button", { className: "dshMcpHub_btn", onClick: () => { setTerminalOut(""); setTerminalId(null); cursorRef.current = 0; } }, "新会话"),
						react.createElement("button", { className: "dshMcpHub_btn", onClick: () => { call("/terminal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", id: terminalId }) }); setTerminalId(null); } , disabled: terminalId === null }, "结束")
					),
					react.createElement("p", { className: "dshMcpHub_dim" },
						overview !== null && overview.platform !== undefined
							? ("在宿主的 " + ((overview.platform.shells[0] || {}).label || "shell") + " 里敲命令：cd 与环境变量都会保留。危险命令（" + (overview.platform.label === "Windows" ? DANGER_EXAMPLES.Windows : DANGER_EXAMPLES.posix) + " 等）被终端层拒绝。")
							: "在宿主的 shell 里敲命令；危险命令被终端层拒绝。"),
					react.createElement("pre", { className: "dshMcpHub_termOut" }, terminalOut === "" ? "（等待第一条命令；回车即执行）" : terminalOut),
					react.createElement("div", { className: "dshMcpHub_searchRow" },
						react.createElement("input", {
							className: "dshMcpHub_input dshMcpHub_mono",
							placeholder: overview !== null && overview.platform !== undefined && overview.platform.label === "Windows"
								? "输入命令，回车执行（例如 dir %USERPROFILE%）"
								: "输入命令，回车执行（例如 ls -la ~）",
							value: terminalInput,
							onChange: (event) => setTerminalInput(event.target.value),
							onKeyDown: (event) => { if (event.key === "Enter") terminalRun(); },
						}),
						react.createElement("button", { className: "dshMcpHub_btnPrimary", onClick: terminalRun }, "执行")
					)
				),

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("h3", { className: "dshMcpHub_h3" }, "DSH 原生工具（" + (Array.isArray(overview !== null ? overview.nativeTools : null) ? overview.nativeTools.length : 0) + "）"),
					react.createElement("p", { className: "dshMcpHub_dim" }, "这些是 DSH 自带的工具，不需要安装；装 MCP 前先看这里，能省一份重复 schema。它们的权限由 DSH 的权限预设（/permission）统一管理。"),
					Array.isArray(overview !== null && overview.nativeTools !== undefined ? overview.nativeTools : null)
						? react.createElement("div", { className: "dshMcpHub_nativeList" }, overview.nativeTools.map((tool) => react.createElement("div", { key: tool.tool, className: "dshMcpHub_nativeItem" },
							react.createElement("span", { className: "dshMcpHub_tag" }, "原生"),
							react.createElement("span", { className: "dshMcpHub_cardTitle" }, tool.label),
							react.createElement("code", { className: "dshMcpHub_cmd" }, tool.tool),
							react.createElement("span", { className: "dshMcpHub_dim" }, tool.description)
						)))
						: null
				),

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("div", { className: "dshMcpHub_rowHead" },
						react.createElement("h3", { className: "dshMcpHub_h3" }, "可装目录（内置 " + builtinCatalog.length + " · 预设 " + externalCatalog.length + "）"),
						react.createElement("span", { className: "dshMcpHub_spacer" }),
						react.createElement("button", { className: "dshMcpHub_link", onClick: () => setCatalogOpen(!catalogOpen) }, catalogOpen ? "收起" : "展开")
					),
					catalogOpen
						? react.createElement("div", null,
							react.createElement("p", { className: "dshMcpHub_dim" }, "内置工具包零依赖、离线可用；预设需要 npx 首次下载。"),
							react.createElement("ul", { className: "dshMcpHub_list" }, [...builtinCatalog, ...externalCatalog].map((item) => react.createElement(CatalogCard, { key: item.name, item, busyName: busy, onInstall: runInstall })))
						)
						: null
				),

				react.createElement("section", { className: "dshMcpHub_block" },
					react.createElement("div", { className: "dshMcpHub_rowHead" },
						react.createElement("h3", { className: "dshMcpHub_h3" }, "自定义 MCP"),
						react.createElement("span", { className: "dshMcpHub_spacer" }),
						react.createElement("button", { className: "dshMcpHub_link", onClick: () => setCustomOpen(!customOpen) }, customOpen ? "收起" : "展开")
					),
					customOpen ? react.createElement("div", { className: "dshMcpHub_form" },
						react.createElement("label", { className: "dshMcpHub_field" }, "服务名（工具前缀 mcp__<名字>__）",
							react.createElement("input", { className: "dshMcpHub_input", value: custom.name, onChange: (event) => setCustom({ ...custom, name: event.target.value }), placeholder: "my-server" })),
						react.createElement("label", { className: "dshMcpHub_field" }, "传输方式",
							react.createElement("select", { className: "dshMcpHub_input", value: custom.transport, onChange: (event) => setCustom({ ...custom, transport: event.target.value }) },
								react.createElement("option", { value: "stdio" }, "stdio（本地命令）"),
								react.createElement("option", { value: "streamable-http" }, "streamable-http（远程地址）"))),
						custom.transport === "stdio" ? react.createElement("div", null,
							react.createElement("label", { className: "dshMcpHub_field" }, "命令",
								react.createElement("input", { className: "dshMcpHub_input", value: custom.command, onChange: (event) => setCustom({ ...custom, command: event.target.value }), placeholder: "npx / node / python3" })),
							react.createElement("label", { className: "dshMcpHub_field" }, "参数（空格分隔，含空格用引号）",
								react.createElement("input", { className: "dshMcpHub_input", value: custom.args, onChange: (event) => setCustom({ ...custom, args: event.target.value }), placeholder: "-y @modelcontextprotocol/server-memory" })),
							react.createElement("label", { className: "dshMcpHub_field" }, "环境变量（每行 KEY=VALUE）",
								react.createElement("textarea", { className: "dshMcpHub_input", rows: 3, value: custom.env, onChange: (event) => setCustom({ ...custom, env: event.target.value }), placeholder: "API_KEY=..." }))
						) : react.createElement("label", { className: "dshMcpHub_field" }, "远程地址",
							react.createElement("input", { className: "dshMcpHub_input", value: custom.url, onChange: (event) => setCustom({ ...custom, url: event.target.value }), placeholder: "https://example.com/mcp" })),
						react.createElement("div", { className: "dshMcpHub_formActions" },
							react.createElement("button", { className: "dshMcpHub_btnPrimary", disabled: busy !== "" || custom.name.trim() === "", onClick: () => {
								const args = splitArgs(custom.args);
								const env = {};
								for (const line of custom.env.split("\n")) {
									const index = line.indexOf("=");
									if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
								}
								runInstall(custom.transport === "stdio"
									? { mode: "custom", name: custom.name.trim(), transport: "stdio", command: custom.command.trim(), args, env }
									: { mode: "custom", name: custom.name.trim(), transport: "streamable-http", url: custom.url.trim() });
							} }, "安装并挂载"),
							react.createElement("span", { className: "dshMcpHub_dim" }, "配置会写进 " + textOf(overview !== null && overview.plugin ? overview.plugin.registryFile : "", "~/.dsh/mcp-hub/servers.json"))
						)
					) : null
				),

				overview !== null && Array.isArray(overview.log) && overview.log.length > 0
					? react.createElement("details", { className: "dshMcpHub_block" },
						react.createElement("summary", { className: "dshMcpHub_link" }, "运行日志（最近 " + overview.log.length + " 行）"),
						react.createElement("pre", { className: "dshMcpHub_log" }, overview.log.slice(-12).join("\n")))
					: null
			);
		}

		/** 极简命令行拆分：支持双引号。 */
		function splitArgs(input) {
			const text = String(input || "").trim();
			if (text === "") return [];
			const parts = [];
			let current = "";
			let quote = null;
			for (let index = 0; index < text.length; index += 1) {
				const char = text[index];
				if (quote !== null) {
					if (char === quote) quote = null;
					else current += char;
					continue;
				}
				if (char === "\"" || char === "'") { quote = char; continue; }
				if (/\s/.test(char)) {
					if (current !== "") { parts.push(current); current = ""; }
					continue;
				}
				current += char;
			}
			if (current !== "") parts.push(current);
			return parts;
		}

		/** 样式：全部走 DSH 主题变量，跟随深浅色。 */
		const CSS = [
			".dshMcpHub_section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}",
			".dshMcpHub_title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dshMcpHub_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".dshMcpHub_h3{margin:0;font-size:14px;font-weight:500;line-height:22px}",
			".dshMcpHub_block{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}",
			".dshMcpHub_stats{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_spacer{flex:1 1 auto}",
			".dshMcpHub_scenarios{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}",
			".dshMcpHub_scenario{display:flex;flex-direction:column;gap:2px;text-align:left;cursor:pointer;font:inherit;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:0 0;color:inherit}",
			".dshMcpHub_scenario:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dshMcpHub_scenario:disabled{opacity:.5;cursor:default}",
			".dshMcpHub_scenarioLabel{font-size:13px;font-weight:500;line-height:20px}",
			".dshMcpHub_scenarioDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dshMcpHub_searchRow{display:flex;gap:8px}",
			".dshMcpHub_input{flex:1 1 auto;font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:8px 10px}",
			"select.dshMcpHub_input,textarea.dshMcpHub_input{flex:none;width:100%}",
			".dshMcpHub_sourceRow{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}",
			".dshMcpHub_check{display:inline-flex;align-items:center;gap:4px}",
			".dshMcpHub_btn,.dshMcpHub_btnPrimary,.dshMcpHub_btnDanger,.dshMcpHub_link{font:inherit;font-size:12px;line-height:18px;cursor:pointer;border-radius:14px;padding:4px 10px;border:.5px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-primary)}",
			".dshMcpHub_btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;padding:6px 14px;font-size:13px}",
			".dshMcpHub_btnDanger{color:var(--dsw-alias-state-error-primary)}",
			".dshMcpHub_btn:disabled,.dshMcpHub_btnPrimary:disabled,.dshMcpHub_btnDanger:disabled{opacity:.4;cursor:default}",
			".dshMcpHub_link{border:none;color:var(--dsw-alias-label-tertiary);padding:2px 4px}",
			".dshMcpHub_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
			".dshMcpHub_card{border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}",
			".dshMcpHub_rowHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dshMcpHub_cardTitle{font-size:13px;font-weight:500;line-height:20px}",
			".dshMcpHub_tag,.dshMcpHub_tagGood{font-size:11px;line-height:16px;border-radius:4px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_tagGood{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".dshMcpHub_meta{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_cmd{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dshMcpHub_dim{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			".dshMcpHub_hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			".dshMcpHub_warn{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-label)}",
			".dshMcpHub_error{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}",
			".dshMcpHub_notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}",
			".dshMcpHub_dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}",
			".dshMcpHub_dotOk{background:var(--dsw-alias-state-success-primary)}",
			".dshMcpHub_dotWarn{background:var(--dsw-alias-state-warn-label)}",
			".dshMcpHub_dotOff{background:var(--dsw-alias-label-tertiary)}",
			".dshMcpHub_toolList{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}",
			".dshMcpHub_toolChip{font-size:11px;line-height:16px;border-radius:4px;padding:1px 5px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_detail{display:flex;flex-direction:column;gap:4px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:6px}",
			".dshMcpHub_form{display:flex;flex-direction:column;gap:8px}",
			".dshMcpHub_field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_formActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".dshMcpHub_log{margin:0;max-height:220px;overflow:auto;font-size:11px;line-height:16px;white-space:pre-wrap;color:var(--dsw-alias-label-tertiary)}",
			".dshMcpHub_permRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dshMcpHub_fieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshMcpHub_select{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:4px 8px}",
			".dshMcpHub_termOut{margin:0;min-height:150px;max-height:320px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:10px;color:var(--dsw-alias-label-primary)}",
			".dshMcpHub_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dshMcpHub_nativeBox{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:8px 10px}",
			".dshMcpHub_nativeList{display:flex;flex-direction:column;gap:4px}",
			".dshMcpHub_nativeItem{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px}",
			".dshMcpHub_scenarioAdvanced{border-style:dashed}",
			".dshMcpHub_docBox{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-module-platform)}",
			".dshMcpHub_docList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}",
			".dshMcpHub_cardMuted{opacity:.65}",
		].join("");

		/** 注册设置页。 */
		function apply(ctx) {
			// 样式：只做一次，失败不影响功能。
			try {
				if (typeof document !== "undefined" && document.head !== undefined) {
					const style = document.createElement("style");
					style.setAttribute("data-dsh-mcp-hub", "");
					style.textContent = CSS;
					document.head.appendChild(style);
				}
			} catch { /* 忽略 */ }
			const slots = ctx.get !== undefined && typeof ctx.get === "function" ? ctx.get("slots") : ctx.slots;
			if (slots === undefined || slots === null || typeof slots.register !== "function") return;
			const sectionInjected = () => ({});
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "mcp-hub",
				order: 45,
				label: () => "MCP 工具",
				inject: sectionInjected,
			}, McpHubSection));
		}

		const inject = ["slots"];

		exports.McpHubSection = McpHubSection;
		exports.CatalogCard = CatalogCard;
		exports.CandidateCard = CandidateCard;
		exports.InstalledCard = InstalledCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

