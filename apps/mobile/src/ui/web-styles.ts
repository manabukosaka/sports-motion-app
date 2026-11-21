import { colors as c, cardShadow } from "./theme.js";

export const webStyles = `
body { margin:0; background:${c.canvas}; }
.sm { --ink:${c.ink}; --secondary:${c.secondary}; --muted:${c.muted}; --accent:${c.accent}; --tint:${c.tint}; --border:${c.border};
  flex:1 0 auto; width:100%; min-height:100vh; background:${c.canvas}; color:var(--ink); font: 14px/1.55 Inter, "Hiragino Sans", "Yu Gothic", Meiryo, system-ui, sans-serif; }
.sm *, .sm *::before, .sm *::after { box-sizing:border-box; }
.sm button, .sm input { font:inherit; }
.sm :focus-visible { outline: 3px solid ${c.cobalt}; outline-offset:3px; }
.sm-shell { width:min(1120px, calc(100% - 64px)); margin:auto; padding:22px 0 28px; display:grid; gap:18px; }
.sm-header { display:flex; justify-content:space-between; align-items:center; gap:10px; }
.sm-brand { display:flex; align-items:center; gap:11px; white-space:nowrap; }
.sm-brand-icon { display:grid; place-items:center; width:44px; height:44px; border-radius:13px; background:var(--ink); color:#5eead4; }
.sm-brand strong { display:block; font-size:20px; letter-spacing:-.055em; line-height:1.1; }
.sm-brand small { color:var(--secondary); font-size:10px; font-weight:650; }
.sm-header .sm-action { min-height:38px; padding:6px 13px; font-size:12px; }
.sm-steps { margin:1px 0 0; padding:6px; list-style:none; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; background:white; border:1px solid var(--border); border-radius:16px; box-shadow:${cardShadow}; }
.sm-step { width:100%; text-align:left; color:var(--secondary); border:1px solid transparent; background:white; border-radius:11px; min-height:51px; display:flex; align-items:center; gap:9px; padding:7px 10px; cursor:pointer; }
.sm-step:hover { background:#f8fafc; }
.sm-step[aria-current] { color:var(--accent); border-color:#9fdfd5; background:var(--tint); }
.sm-step strong { font-size:13px; }
.sm-step-number { width:27px; height:27px; border-radius:50%; display:grid; place-items:center; margin:0; flex:none; font:700 12px ui-monospace, monospace; background:#f1f5f9; color:var(--secondary); }
.sm-step[aria-current] .sm-step-number { background:var(--accent); color:white; box-shadow:0 0 0 3px #c9eee8; }
.sm-step[data-visited="true"]:not([aria-current]) .sm-step-number { background:${c.successSurface}; color:#047857; }
.sm-heading { min-width:0; }
.sm-heading h1 { margin:0; font-size:clamp(25px, 4vw, 38px); letter-spacing:-.05em; line-height:1.18; }
.sm-heading p { color:var(--secondary); margin:6px 0 0; font-size:13px; }
.sm-guide { background:var(--tint); border:1px solid #c5e9e3; border-radius:13px; display:flex; align-items:center; gap:12px; padding:9px 13px; color:#164e49; }
.sm-guide[data-tone="warning"] { background:${c.warningSurface}; border-color:#fde68a; color:#78350f; }
.sm-guide[data-tone="success"] { background:${c.successSurface}; border-color:#a7f3d0; color:#065f46; }
.sm-guide strong { font-size:12px; display:block; }
.sm-guide p { font-size:12px; margin:1px 0 0; }
.sm-badge { flex:none; border:1px solid currentColor; border-radius:7px; padding:2px 6px; font:700 11px/1.5 ui-monospace, monospace; }
.sm-panel { min-width:0; padding:16px; display:grid; align-content:start; gap:11px; background:white; border:1px solid var(--border); border-radius:18px; box-shadow:${cardShadow}; }
.sm-panel h2 { margin:0; font-size:15px; font-weight:780; letter-spacing:-.02em; }
.sm-panel .sm-panel { box-shadow:none; border-radius:12px; background:#f8fafc; }
.sm-row { display:flex; flex-wrap:wrap; align-items:center; gap:7px; }
.sm-copy { margin:0; color:var(--secondary); overflow-wrap:anywhere; }
.sm-copy strong { color:var(--ink); }
.sm-grid { display:grid; gap:14px; }
.sm-grid[data-layout="split"] { grid-template-columns:minmax(0, 1.15fr) minmax(0, 1fr); align-items:start; }
.sm-grid[data-layout="equal"] { grid-template-columns:repeat(2,minmax(0,1fr)); }
.sm-grid[data-layout="choices"] { grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.sm-choice { text-align:left; color:var(--ink); background:white; cursor:pointer; min-width:0; min-height:66px; border:1px solid var(--border); border-radius:11px; padding:9px; display:flex; align-items:center; gap:8px; }
.sm-choice:hover { border-color:var(--accent); }
.sm-choice[aria-pressed="true"] { border-color:var(--accent); background:#f2fbf9; box-shadow:inset 0 0 0 1px var(--accent); }
.sm-choice strong, .sm-choice small { display:block; }
.sm-choice strong { font-size:12px; line-height:1.4; }
.sm-choice small { color:var(--secondary); font-size:10px; line-height:1.45; margin-top:3px; }
.sm-choice-icon { border-radius:8px; display:grid; place-items:center; flex:none; width:30px; height:30px; background:#edf2f7; color:var(--accent); }
.sm-choice[aria-pressed="true"] .sm-choice-icon { background:#d1eee9; }
.sm-notice { margin:0; padding:9px 12px; background:${c.warningSurface}; color:${c.warning}; border-radius:9px; font-size:12px; }
.sm-notice[data-tone="success"] { background:#ecfdf5; color:#065f46; }
.sm-notice[data-non-diagnostic] { background:#eef2f6; color:#485970; border-radius:10px; }
.sm-action { border:1.5px solid ${c.outline}; display:inline-flex; align-items:center; justify-content:center; gap:5px; min-height:42px; font-weight:720 !important; font-size:13px !important; padding:6px 12px; border-radius:12px; color:var(--ink); background:white; cursor:pointer; text-align:center; }
.sm-action[data-variant="primary"] { border-color:transparent; color:white; background:linear-gradient(135deg, #0f766e, #0d9488); box-shadow:0 3px 8px #0f766e30; text-shadow:0 1px 2px #064e46; }
.sm-action[data-variant="chip"] { border-radius:999px; min-height:34px; padding:4px 11px; }
.sm-action[data-variant="ghost"] { border-color:transparent; background:transparent; color:var(--secondary); }
.sm-action[aria-pressed="true"] { border-color:var(--accent); background:var(--tint); color:var(--accent); }
.sm-action:not(:disabled):hover { filter:brightness(.94); }
.sm-action:disabled { opacity:.48; cursor:default; box-shadow:none; }
.sm-footer { padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:6px; background:white; border:1px solid var(--border); border-radius:15px; box-shadow:${cardShadow}; }
.sm-footer > div { display:flex; gap:6px; align-items:center; margin-left:auto; }
.sm-link { display:inline-flex; width:fit-content; color:var(--accent); font-weight:700; text-underline-offset:3px; padding:5px 2px; }
.sm-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
.sm-stat { min-width:0; padding:10px 13px; border:1px solid var(--border); border-radius:12px; background:white; }
.sm-stat span { display:block; font-size:11px; font-weight:700; color:var(--secondary); }
.sm-stat strong { display:inline-block; font-size:27px; font-variant-numeric:tabular-nums; letter-spacing:-.04em; line-height:1.3; }
.sm-stat small { padding-left:4px; color:var(--secondary); font-weight:700; }
.sm-stat em { display:inline-block; margin:0 0 0 7px; padding:1px 5px; border-radius:5px; background:var(--tint); color:var(--accent); font:700 10px/1.5 ui-monospace, monospace; }
.sm-switch { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px; min-height:50px; background:#f8fafc; border:1px solid var(--border); border-radius:11px; color:var(--ink); font-weight:750 !important; text-align:left; cursor:pointer; }
.sm-switch:disabled { cursor:default; }
.sm-switch-track { width:42px; height:24px; border-radius:999px; background:#64748b; padding:3px; flex:none; display:flex; }
.sm-switch[aria-checked="true"] .sm-switch-track { justify-content:end; background:var(--accent); }
.sm-switch-track::after { content:''; display:block; width:18px; height:18px; border-radius:50%; background:white; }
.sm-scrubber { display:grid; gap:3px; font-size:11px; font-weight:650; color:var(--secondary); }
.sm-scrubber input { width:100%; height:25px; margin:0; accent-color:var(--accent); cursor:pointer; }
.sm-drop { display:grid; justify-items:center; text-align:center; gap:5px; min-height:128px; align-content:center; background:#f8fcfb; border:1.5px dashed #90bbb4; border-radius:13px; padding:12px; color:var(--secondary); cursor:pointer; overflow-wrap:anywhere; }
.sm-drop:hover, .sm-drop[data-dragging="true"] { background:var(--tint); border-color:var(--accent); }
.sm-drop:focus-within { outline:3px solid ${c.cobalt}; outline-offset:2px; }
.sm-drop strong { color:var(--accent); }
.sm-drop small { font-size:11px; }
.sm-drop-icon { display:grid; place-items:center; width:33px; height:33px; border-radius:9px; background:#dff3ee; color:var(--accent); }
.sm-file { position:absolute; width:1px; height:1px; clip-path:inset(50%); overflow:hidden; }
.sm-video { display:block; width:100%; max-height:260px; border-radius:12px; background:var(--ink); }
.sm-line-card { overflow:hidden; position:relative; padding:19px; display:grid; gap:7px; border-radius:14px; background:${c.dark}; color:white; min-height:150px; }
.sm-line-card::after { content:''; position:absolute; pointer-events:none; right:-28px; bottom:-65px; width:220px; height:220px; border-radius:50%; border:1px solid #5eead44d; box-shadow:0 0 0 22px #5eead415,0 0 0 45px #5eead410; }
.sm-line-card span { width:fit-content; color:#bbf7d0; background:#14532d; border-radius:5px; padding:2px 6px; font-size:10px; font-weight:800; }
.sm-line-card strong { font-size:24px; letter-spacing:-.04em; }
.sm-line-card small { color:#cbd5e1; max-width:33ch; z-index:1; }
.sm-line-image { display:block; width:100%; border-radius:14px; }
@media (max-width: 740px) {
  .sm-shell { width:calc(100% - 28px); padding-top:14px; gap:12px; }
  .sm-grid[data-layout="split"], .sm-grid[data-layout="equal"] { grid-template-columns:1fr; gap:12px; }
  .sm-steps { gap:3px; padding:4px; }
  .sm-step { flex-direction:column; justify-content:center; text-align:center; gap:4px; padding:5px 1px; min-height:59px; }
  .sm-step strong { font-size:10px; }
  .sm-step-number { width:22px; height:22px; }
  .sm-header .sm-row { gap:3px; justify-content:flex-end; }
  .sm-header .sm-action { font-size:10px !important; padding:5px 6px; min-height:42px; }
  .sm-brand-icon { width:34px; height:34px; border-radius:9px; }
  .sm-brand { gap:6px; }
  .sm-brand strong { font-size:17px; }
  .sm-brand small { font-size:8px; }
  .sm-panel { padding:12px; }
  .sm-stat { padding:8px; }
  .sm-stat strong { font-size:20px; }
  .sm-choice { flex-direction:column; text-align:center; padding:7px 4px; }
  .sm-grid:not([data-layout="choices"]) > .sm-choice { flex-direction:row; text-align:left; padding:8px; }
}
`;
