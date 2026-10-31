import { AVATAR_CSS } from './avatar.tsx'
import { ENGINE_LOGO_CSS } from './engine-logos.js'
import { RUNNING_CSS } from './running.js'
import { TOOL_CALL_CSS } from './tool-call.tsx'
import { TOOL_TIMELINE_CSS } from './tool-timeline.tsx'
import { CODE_DIFF_CSS } from './code-diff.tsx'
import { FILE_CHANGES_SUMMARY_CSS } from './file-changes-summary.tsx'
import { CHANGES_PANEL_CSS } from './changes-panel.tsx'
import { COMPOSER_ATTACHMENTS_CSS } from './composer-attachments.tsx'
import terminalCss from '@xterm/xterm/css/xterm.css'
import { WARN_INK } from './ui-shared.js'
const TERMINAL_CSS = terminalCss.replace(/#000\b/gi, 'var(--dsw-alias-bg-base)').replace(/#fff\b/gi, 'var(--dsw-alias-label-primary)').replaceAll('rgba(0,0,0,0)', 'transparent')

export const CSS = TERMINAL_CSS + AVATAR_CSS + ENGINE_LOGO_CSS + RUNNING_CSS + TOOL_CALL_CSS + TOOL_TIMELINE_CSS + CODE_DIFF_CSS + FILE_CHANGES_SUMMARY_CSS + CHANGES_PANEL_CSS + COMPOSER_ATTACHMENTS_CSS + `
.nodo-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-page *{box-sizing:border-box}
.nodo-space{height:100%;display:flex;flex-direction:column;background:var(--nodo-chrome,var(--dsw-specific-sidebar-fill))}
.nodo-space-chrome{box-sizing:border-box;height:max(36px,var(--nodo-top-clearance,0px));flex:none;display:flex;justify-content:flex-end;align-items:flex-start;padding:10px 12px 0;-webkit-app-region:drag}
.nodo-space-chrome>*{display:flex;align-items:center;min-height:30px}
.nodo-space-chrome button{-webkit-app-region:no-drag}
.nodo-space-content{display:flex;flex:1;min-width:264px;min-height:0;animation:nodo-space-in var(--ds-transition-duration-slow,.3s) var(--ds-ease-in-out,ease) backwards}
@keyframes nodo-space-in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.nodo-space-content{animation:none}}
.nodo-space-sidebar{flex:1;overflow:hidden;background:var(--dsw-specific-sidebar-fill)}
.nodo-space-sidebar .nodo-frame{flex-direction:column}
.nodo-space-sidebar .nodo-rail{width:100%;max-height:none;flex:1;border:0}
.nodo-space-sidebar .nodo-rail-dock{padding-top:8px}
.nodo-space-sidebar .nodo-rail-body{padding-top:12px}
/* The Windows host already lays its columns out below the titlebar. The desktop
   sidebar toggle stays where the host puts it: in the Windows titlebar ahead of
   the menu, and on macOS in the window-chrome seat that the host fills itself
   while the sidebar is collapsed. */
html[data-platform=darwin]{--nodo-top-clearance:var(--dsh-frame-top-clearance,0px)}
.nodo-left-control{display:none}
html:is([data-platform=darwin],[data-windows-titlebar]) .nodo-left-control{position:absolute;display:flex;pointer-events:auto;-webkit-app-region:no-drag}
html:is([data-platform=darwin],[data-windows-titlebar]) .nodo-left-control button{width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm)}
html[data-platform=darwin] .nodo-left-control{top:11px;left:88px}
html[data-platform=darwin][data-fullscreen] .nodo-left-control{left:12px}
html[data-platform=darwin][data-nodo-space] :has(> [data-rightbar-col]):not([data-sidebar-collapsed]){--dsh-frame-leading-clearance:var(--nodo-leading-clearance,0px)}
html[data-platform=darwin] [data-sidebar-collapsed] .nodo-left-control,html[data-platform=darwin] .nodo-space-chrome>*{display:none}
html[data-windows-titlebar] .nodo-left-control{top:calc((var(--dsh-windows-titlebar-height) - 28px) / 2);left:12px}
html[data-windows-titlebar][data-nodo-space]:has([data-sidebar-collapsed=true]){--dsh-windows-menu-start:48px}
html[data-windows-titlebar] .nodo-space-chrome{display:none}
/* The host's own top row (terminal tab strip, right icon) centres ~19px below
   the columns; the rail tabs and the title row follow that line. */
html[data-windows-titlebar] .nodo-space-sidebar .nodo-rail-body{padding-top:6px}
html[data-windows-titlebar] .nodo-space-sidebar .nodo-rail-tabs{margin-top:-2px}
html[data-windows-titlebar] .nodo-head{padding-top:4px}
html[data-windows-titlebar] .nodo-right-head{padding-top:4px}
html[data-windows-titlebar] .nodo-right-control{top:calc(var(--dsh-frame-chrome-top,0px) + 4px)}
/* The macOS host only exposes its frame columns through these data attributes:
   the centre column sits right before [data-rightbar-col]. Theme tokens resolve
   below <html>, so the chrome variables live on the frame. */
html[data-platform=darwin][data-nodo-space] :has(> [data-rightbar-col]){--nodo-frame-gap:8px;--nodo-chrome:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-specific-sidebar-fill));--nodo-card-radius:var(--dsw-radius-lg);--nodo-card-edge:.5px solid var(--dsw-alias-border-l3);background:var(--nodo-chrome)}
html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col]){position:relative;isolation:isolate;margin:0 var(--nodo-frame-gap) 8px 0;border-left:0;border-radius:0 0 var(--nodo-card-radius) 0;background:0 0}
html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col])::before,html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col])::after{content:'';position:absolute;inset:var(--dsh-frame-top-clearance,0px) 0 0;box-sizing:border-box;border-radius:0 var(--nodo-card-radius) var(--nodo-card-radius) 0;pointer-events:none}
html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col])::before{z-index:-1;background:var(--dsw-alias-bg-base)}
html[data-platform=darwin][data-nodo-space] :has(+ [data-rightbar-col])::after{z-index:1;border:var(--nodo-card-edge);border-left:0}
html[data-platform=darwin][data-nodo-space] [data-sidebar-collapsed]>:has(+ [data-rightbar-col]){margin-left:8px;border-radius:0 0 var(--nodo-card-radius) var(--nodo-card-radius)}
html[data-platform=darwin][data-nodo-space] [data-sidebar-collapsed]>:has(+ [data-rightbar-col])::before,html[data-platform=darwin][data-nodo-space] [data-sidebar-collapsed]>:has(+ [data-rightbar-col])::after{border-radius:var(--nodo-card-radius)}
html[data-platform=darwin][data-nodo-space] [data-sidebar-collapsed]>:has(+ [data-rightbar-col])::after{border-left:var(--nodo-card-edge)}
html[data-platform=darwin][data-nodo-space] [data-phase]:has(header[data-window-drag]){background:0 0}
html[data-platform=darwin][data-nodo-space] header[data-window-drag]{border-bottom-color:transparent}
html[data-platform=darwin][data-nodo-space] header[data-window-drag]:has([data-conversation-tabs]>:only-child){min-height:var(--dsh-frame-top-clearance,0px);padding-bottom:0}
html[data-platform=darwin][data-nodo-space] [data-conversation-tabs]:has(>:only-child){display:none}
html[data-platform=darwin][data-nodo-space] .nodo-page:not(.nodo-space-sidebar){background:0 0}
html[data-platform=darwin][data-nodo-space] .nodo-head,html[data-platform=darwin][data-nodo-space] .nodo-right-head{border-bottom:0}
html[data-platform=darwin][data-nodo-space] [data-rightbar-col]:has(.nodo-right-panel){background:transparent}
html[data-platform=darwin][data-nodo-space] .nodo-right-panel{border:0;background:transparent}
html[data-platform=darwin][data-nodo-space] .nodo-right-content{margin:0 var(--nodo-frame-gap) var(--nodo-frame-gap) 0;border:var(--nodo-card-edge);border-radius:var(--nodo-card-radius);background:var(--dsw-alias-bg-base)}
html[data-platform=darwin][data-nodo-space] :is(.nodo-right-files,.nodo-right-directory,.nodo-right-preview){border-radius:max(0px,calc(var(--nodo-card-radius) - .5px))}
html[data-platform=darwin][data-nodo-space] :is(.nodo-right-card,.nodo-right-image){border-radius:max(0px,calc(var(--nodo-card-radius) - 12px - .5px))}
html[data-platform=darwin][data-nodo-space] .nodo-right-file{border-radius:max(0px,calc(var(--nodo-card-radius) - 8px - .5px))}
html[data-platform=darwin][data-nodo-space] :is(.nodo-space-sidebar,.nodo-space-sidebar .nodo-rail,.nodo-space-sidebar .nodo-rail-dock){border:0;background:0 0}
html[data-platform=darwin][data-nodo-space] .nodo-space-sidebar .nodo-rail-body{margin-bottom:8px;padding-top:16px;border:var(--nodo-card-edge);border-radius:var(--nodo-card-radius) 0 0 var(--nodo-card-radius);background:var(--dsw-specific-sidebar-fill)}
/* Only the page's own text nodes are reset; the host renderer keeps its own
   heading and paragraph rhythm inside .nodo-reply. */
.nodo-page :is(.nodo-headline,.nodo-note,.nodo-error-line,.nodo-rail-empty,.nodo-feed-empty){margin:0}
.nodo-page .nodo-headline{font-size:18px;font-weight:600;line-height:26px}
.nodo-frame{display:flex;flex:1;min-height:0}
/* The rail body copies the host sidebar: 12px inline padding, 28px icon buttons
   and 16px row actions that only appear on hover. */
/* The host sidebar reserves a 52px top strip and pulls its brand row up 12px, so
   the rail keeps the same 40px of chrome above its own head. */
.nodo-rail{display:flex;flex:none;width:312px;min-height:0;background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--nodo-rail-hover:var(--dsw-specific-sidebar-nav-item-hover)}
.nodo-rail-dock{display:flex;flex-direction:column;align-items:center;gap:4px;flex:none;width:56px;box-sizing:border-box;padding:max(12px,calc(var(--nodo-top-clearance,0px) - 2px)) 0 12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-specific-sidebar-fill));border-right:.5px solid var(--dsw-alias-border-l3)}
.nodo-rail-dock .nodo-icon-btn{width:36px;height:36px;border-radius:var(--dsw-radius-md)}
.nodo-rail-dock .nodo-icon-btn[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px var(--dsw-alias-border-l2),0 0 0 .5px var(--dsw-alias-border-l2)}
.nodo-rail-spacer{flex:1}
.nodo-rail-body{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;--nodo-rail-inset:12px;padding:max(6px,calc(var(--nodo-top-clearance,0px) - 8px)) var(--nodo-rail-inset) 6px}
.nodo-space-sidebar .nodo-rail-tabs{margin-top:-10px}
.nodo-rail-tabs{display:grid;grid-template-columns:1fr 1fr;flex:none;margin:0 2px 8px;box-shadow:inset 0 -.5px 0 var(--dsw-alias-border-l2)}
.nodo-rail-tabs>button{height:32px;padding:0;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;font-weight:500;cursor:pointer}
.nodo-rail-tabs>button:hover{color:var(--dsw-alias-label-primary)}
.nodo-rail-tabs>button[aria-selected=true]{box-shadow:inset 0 -2px 0 var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);cursor:default}
.nodo-rail-head{display:flex;align-items:center;justify-content:space-between;flex:none;height:28px;padding:0 6px 0 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:18px}
.nodo-roster{display:flex;flex-direction:column;gap:2px;flex:none;min-height:0;padding-bottom:4px}
.nodo-roster-list{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto}
.nodo-rail-split{flex:none;height:9px;margin:0 2px;background:linear-gradient(var(--dsw-alias-border-l3),var(--dsw-alias-border-l3)) center/100% .5px no-repeat;cursor:row-resize;touch-action:none}
.nodo-rail-split:hover,.nodo-rail-split:focus-visible{outline:0;background-image:linear-gradient(var(--dsw-alias-state-business-primary),var(--dsw-alias-state-business-primary));background-size:100% 2px}
.nodo-roster-cell{display:flex;align-items:center;gap:2px;min-width:0;border-radius:var(--dsw-radius-md)}
.nodo-roster-cell:hover .nodo-row-actions,.nodo-roster-cell:focus-within .nodo-row-actions{display:inline-flex}
.nodo-roster-item{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:36px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-roster-cell:hover{background:var(--nodo-rail-hover)}
.nodo-roster-cell:has(>.nodo-roster-item[aria-current=true]){background:var(--dsw-specific-sidebar-nav-item-active)}
.nodo-roster-avatar{display:inline-flex;flex:none}
.nodo-roster-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.nodo-roster-new{color:var(--dsw-alias-label-tertiary)}
.nodo-roster-new:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.nodo-roster-new:disabled{cursor:default}
.nodo-roster-plus{display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:20px;height:20px;border:1px dashed var(--dsw-alias-border-l1);border-radius:28%}
.nodo-tree-flag{display:inline-flex;flex:none;color:var(--dsw-alias-state-business-primary)}
.nodo-tree{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;margin:4px calc(-1 * var(--nodo-rail-inset)) 0;padding:0 var(--nodo-rail-inset) 16px}
.nodo-tree-node,.nodo-tree-children{display:flex;flex-direction:column;gap:2px}
.nodo-tree-state{display:inline-flex;align-items:center;gap:4px;flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.nodo-logo{display:block;max-width:100%;height:auto;color:var(--dsw-alias-label-primary)}
.nodo-panel-logo{display:inline-flex;align-items:center}
button[aria-label="Nodo"]:has(.nodo-panel-logo)>span:not(:has(.nodo-panel-logo)){display:none}
.nodo-rail-foot{flex:none;padding:8px 0}
.nodo-search-dialog{display:flex;flex-direction:column;width:min(640px,100%);max-height:min(504px,100%);padding:0;overflow:hidden;--nodo-rail-hover:var(--dsw-specific-sidebar-nav-item-hover)}
.nodo-search-dialog *{box-sizing:border-box}
.nodo-search-box{display:flex;align-items:center;gap:12px;flex:none;height:56px;padding:0 14px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.nodo-search-box input{flex:1;min-width:0;height:100%;border:0;outline:0;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px}
.nodo-search-box input::placeholder{color:var(--dsw-alias-label-tertiary)}
.nodo-search-box input::-webkit-search-cancel-button{display:none}
.nodo-search-list{display:flex;flex-direction:column;gap:2px;min-height:0;padding:8px;overflow-y:auto}
.nodo-search-row{display:flex;align-items:center;gap:12px;flex:none;height:40px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.nodo-search-row[data-active]{background:var(--nodo-rail-hover)}
.nodo-search-avatar{display:inline-flex;flex:none}
.nodo-search-avatar[data-lead]>.nodo-avatar{outline:1.5px solid color-mix(in srgb,currentColor 75%,var(--dsw-alias-label-primary));outline-offset:1.5px}
.nodo-search-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-search-project,.nodo-search-meta{display:flex;align-items:center;gap:6px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nodo-search-project{width:132px;min-width:0}
.nodo-search-project>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-search-meta{justify-content:flex-end;width:64px}
.nodo-search-row[data-active] .nodo-search-meta{color:var(--dsw-alias-label-primary)}
.nodo-rail-empty{padding:8px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-project,.nodo-row{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-project{height:34px;padding:0 4px}
.nodo-project:hover{background:var(--nodo-rail-hover)}
.nodo-project .nodo-row-actions{padding-right:2px}
.nodo-project .nodo-chevron[data-open]{transform:rotate(90deg)}
.nodo-picker{display:flex;flex:1;min-width:0}
.nodo-project-select{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:100%;padding:0 4px;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.nodo-chevron{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-caption);transition:transform .15s var(--ds-ease-in-out)}
.nodo-chevron[data-open]{transform:rotate(180deg)}
.nodo-project-pick{gap:6px;max-width:240px}
.nodo-project-pick>.nodo-row-title{font-size:inherit;line-height:inherit}
.nodo-project-state{display:inline-flex;flex:none}
.nodo-menu-label{display:inline-flex;align-items:center;gap:6px}
.nodo-menu-dot{display:inline-flex}
/* Row actions follow the host's own workspace row: hidden until the row is
   hovered, its menu is open, or a button inside holds the keyboard. */
.nodo-row-actions{display:none;flex:none;align-items:center;gap:2px}
.nodo-project:hover .nodo-row-actions,.nodo-project:focus-within .nodo-row-actions,.nodo-project[data-menu=open] .nodo-row-actions{display:inline-flex}
.nodo-project[data-menu=open]{background:var(--nodo-rail-hover)}
.nodo-row-action{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-row-action>svg{width:16px;height:16px}
.nodo-row-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-row-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.nodo-folder{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-deep-diving)}
.nodo-project-select[aria-expanded=false]>.nodo-folder{color:var(--dsw-alias-label-tertiary)}
.nodo-project-select[aria-expanded=true]>.nodo-folder{color:var(--dsw-alias-state-business-primary)}
.nodo-show-more,.nodo-roster-more{margin:2px 0 0;padding:6px 8px;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.nodo-show-more:hover,.nodo-roster-more:hover{color:var(--dsw-alias-label-primary)}
.nodo-row{height:36px;padding:0 8px}
.nodo-session-empty{padding:8px 12px 8px 32px}
.nodo-session-item{display:flex;align-items:center;gap:2px;width:100%;padding-right:6px;box-sizing:border-box;border-radius:var(--dsw-radius-md)}
.nodo-session-item>.nodo-session{flex:1;min-width:0}
.nodo-session-item:hover .nodo-row-actions,.nodo-session-item:focus-within .nodo-row-actions,.nodo-session-item[data-menu=open] .nodo-row-actions{display:inline-flex}
.nodo-session[data-archived]{color:var(--dsw-alias-label-tertiary)}
.nodo-row-archived{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-row:hover{background:var(--nodo-rail-hover)}
.nodo-row[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active)}
.nodo-session-item:hover{background:var(--nodo-rail-hover)}
.nodo-session-item:has(>.nodo-session[aria-current=page]){background:var(--dsw-specific-sidebar-nav-item-active)}
.nodo-session-item>.nodo-session{background:0 0}
.nodo-row-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.nodo-session .nodo-row-title{flex:1}
.nodo-session{gap:8px}
.nodo-session .nodo-avatar{flex:none}
.nodo-row-meta{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-project .nodo-row-meta{margin-left:0}
.nodo-row-state,.nodo-row-running{display:inline-flex;align-items:center;gap:4px;flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.nodo-dot{position:relative;display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--nodo-dot)}
.nodo-dot[data-s=run]{--nodo-dot:var(--dsw-alias-state-success-primary)}
.nodo-dot[data-s=wait]{--nodo-dot:var(--dsw-alias-state-warn-primary)}
.nodo-dot[data-s=done]{--nodo-dot:var(--dsw-alias-state-business-primary)}
.nodo-dot[data-s=err]{--nodo-dot:var(--dsw-alias-state-error-primary)}
.nodo-dot[data-s=stop]{background:none;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-label-tertiary)}
.nodo-dot[data-s=run]::after{content:'';position:absolute;inset:0;border-radius:50%;background:var(--nodo-dot);animation:nodo-dot-pulse 2.2s ease-out infinite}
@keyframes nodo-dot-pulse{0%{transform:scale(1);opacity:.55}80%,100%{transform:scale(2.6);opacity:0}}
@media (prefers-reduced-motion:reduce){.nodo-dot[data-s=run]::after{animation:none}}
.nodo-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transition:background-color .1s,color .1s}
.nodo-icon-btn:focus-visible,.nodo-icon-btn[aria-pressed=true],.nodo-icon-btn.nodo-visible{opacity:1}
.nodo-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-page button:disabled{cursor:not-allowed;opacity:.4}
.nodo-page :focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.nodo-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.nodo-conversation{display:flex;flex-direction:column;flex:1;min-height:0}
/* Host conversation header geometry: 20px inline start, a 30px title row inside
   the window-chrome band, then a hairline. */
.nodo-head{box-sizing:border-box;display:flex;flex-direction:column;flex:none;min-height:var(--nodo-top-clearance,0px);padding:10px 50px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.nodo-title-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:30px;padding-inline-start:max(0px,calc(var(--dsh-frame-leading-clearance,0px) - 20px))}
.nodo-crumb{min-width:0;padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.nodo-crumb-link{flex:none;max-width:40%;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer}
.nodo-crumb-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-crumb-sep{flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.nodo-head-actions{display:flex;align-items:center;flex:none;margin-left:auto}
.nodo-head-actions>*{display:flex;align-items:center}
/* The kit has no right-panel icon; the native rightbar mirrors the left one on
   the svg itself (dsh-client-ui-sidebar-right collapseGlyph). */
.nodo-right-glyph{transform:scaleX(-1)}
.nodo-right-control{position:absolute;top:calc(var(--dsh-frame-chrome-top,0px) + 10px);right:12px;display:flex;align-items:center;height:30px;pointer-events:auto;-webkit-app-region:no-drag}
.nodo-right-toggle{flex:none;width:30px;height:30px;padding:0}
.nodo-right-panel{box-sizing:border-box;position:absolute;top:0;bottom:0;right:0;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;border-left:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px}
.nodo-right-panel[hidden],.nodo-right-directory[hidden]{display:none}
.nodo-right-panel{animation:nodo-right-in var(--ds-transition-duration-slow,.3s) var(--ds-ease-in-out,ease) backwards}
@keyframes nodo-right-in{from{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.nodo-right-panel{animation:none}}
.nodo-right-pane[hidden]{display:none}
.nodo-right-pane,.nodo-terminal{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}
.nodo-terminal{padding:8px;border-radius:inherit}
.nodo-terminal-screen{flex:1;min-height:0;min-width:0;overflow:hidden}
.nodo-right-panel *{box-sizing:border-box}
/* Both headers reserve 12px + 30px + 8px for the frame overlay control. */
.nodo-right-head{box-sizing:border-box;display:flex;flex-direction:column;flex:none;min-height:var(--nodo-top-clearance,0px);padding:10px 50px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.nodo-right-head button{-webkit-app-region:no-drag}
.nodo-right-tabs{display:flex;align-items:center;gap:4px;min-height:30px;overflow-x:auto}
.nodo-right-tabs>button{flex:none;width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary)}
.nodo-right-tabs>button:hover{color:var(--dsw-alias-label-secondary)}
.nodo-right-tab{display:flex;align-items:center;flex:none;gap:2px;height:28px;padding:0 4px 0 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}
.nodo-right-tab:hover,.nodo-right-tab[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-right-tab[data-active]{color:var(--dsw-alias-label-primary)}
.nodo-right-tab>button:first-child{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.nodo-right-tab-close{flex:none;width:20px;height:20px;padding:0;border-radius:calc(var(--dsw-radius-sm) - 4px);color:var(--dsw-alias-label-tertiary)}
.nodo-right-tab-close:hover{color:var(--dsw-alias-label-secondary)}
.nodo-right-content{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}
.nodo-right-home{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;padding:12px 12px 40px}
.nodo-right-home>.nodo-right-card:first-child{margin-top:auto}
.nodo-right-home>.nodo-right-card+.nodo-right-card{margin-top:8px}
.nodo-right-home>.nodo-right-card:last-child{margin-bottom:auto}
.nodo-right-card{display:flex;align-items:center;flex:none;gap:12px;width:100%;min-height:75px;padding:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer}
.nodo-right-card>svg{flex:none}
.nodo-right-card>span{display:flex;flex-direction:column;min-width:0;gap:2px}
.nodo-right-card strong{font-weight:500}
.nodo-right-card small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.nodo-right-card:hover,.nodo-right-file:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-right-files,.nodo-right-preview{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.nodo-right-directory{flex:1;overflow:auto;padding:8px}
.nodo-right-file{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.nodo-right-file>svg,.nodo-right-file-icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-right-file-icon{display:flex;width:14px;margin-left:18px}
.nodo-right-file>span:last-child,.nodo-right-preview-head>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-right-status{margin:0;padding:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nodo-right-preview-head{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.nodo-right-preview-head>span{flex:1}
.nodo-right-preview-body{flex:1;min-height:0;overflow:auto;padding:12px;overflow-wrap:anywhere}
.nodo-right-image{display:block;width:100%;padding:0;border:0;border-radius:var(--dsw-radius-md);background:transparent;cursor:zoom-in;overflow:hidden}
.nodo-right-image>img{display:block;max-width:100%;height:auto;margin:auto}
.nodo-browser,.nodo-browser-viewport{display:flex;flex:1;min-height:0;min-width:0;overflow:hidden}
.nodo-browser{flex-direction:column;border-radius:inherit}
.nodo-browser-toolbar{display:flex;align-items:center;flex:none;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.nodo-browser-toolbar>button{flex:none;height:28px;padding:0 6px;white-space:nowrap}
.nodo-browser-toolbar>button[aria-label]{width:28px;padding:0}
.nodo-browser-toolbar>form{flex:1;min-width:0}
.nodo-browser-toolbar input{width:100%;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}
.nodo-browser-toolbar input:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.nodo-browser-frame{display:flex;flex:1;width:100%;min-width:0;min-height:0;border:0;background:var(--dsw-alias-bg-base)}
.nodo-round-faces{display:inline-flex;flex:none;gap:2px}
.nodo-feed-inner[data-round]>:not(.nodo-user,.nodo-round-speaker,.nodo-round-member){margin-left:40px}
.nodo-feed-inner[data-round]>*+:is(.nodo-user,.nodo-round-speaker,.nodo-round-member){margin-top:18px}
.nodo-feed-inner[data-round]>.nodo-round-speaker+*{margin-top:4px}
.nodo-feed-inner[data-round]>.nodo-round-chip{margin-top:6px}
.nodo-round-speaker,.nodo-round-head{display:flex;align-items:center;gap:8px;min-width:0;height:28px}
.nodo-round-speaker>.nodo-avatar{margin-right:4px}
.nodo-round-member{display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:12px;align-items:start}
.nodo-round-body{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:var(--dsh-content-font-size,14px);line-height:22px}
.nodo-round-role{flex:none;font-weight:500}
.nodo-round-speaker>.nodo-round-role,.nodo-round-head>.nodo-round-role{font-weight:600}
.nodo-round-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.nodo-tag{--nodo-tag-tone:var(--dsw-alias-label-secondary);display:inline-block;flex:none;max-width:100%;height:20px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--nodo-tag-tone);font-size:12px;font-weight:400;line-height:20px;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nodo-tag[data-tone]{background:color-mix(in srgb,var(--nodo-tag-tone) 10%,transparent)}
.nodo-tag[data-tone=accent]{--nodo-tag-tone:var(--dsw-alias-state-business-primary)}
.nodo-tag[data-tone=caution]{--nodo-tag-tone:var(--dsw-alias-state-warn-primary);color:${WARN_INK}}
.nodo-round-status{display:inline-flex;align-items:center;gap:5px;flex:none;color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums}
.nodo-round-status[data-state=live]{color:var(--dsw-alias-label-secondary)}
.nodo-round-status[data-state=ended]{color:${WARN_INK}}
.nodo-round-open{display:inline-flex;align-items:center;flex:none;gap:5px;height:26px;margin-left:auto;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.nodo-round-open+.nodo-round-open{margin-left:0}
.nodo-round-open:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-round-summary{display:flex;align-items:flex-start;gap:6px;align-self:flex-start;max-width:100%;margin:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
button.nodo-round-summary{cursor:pointer}
.nodo-round-summary>svg{flex:none;margin-top:4px;color:var(--dsw-alias-label-caption);transition:transform .15s}
.nodo-round-summary[aria-expanded=true]>svg{transform:rotate(180deg)}
.nodo-round-summary:focus-visible,.nodo-round-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-round-quiet{margin:0;color:var(--dsw-alias-label-tertiary)}
.nodo-round-report{min-width:0;color:var(--dsw-alias-label-secondary)}
.nodo-round-tools{display:flex;flex-direction:column;gap:2px;min-width:0}
.nodo-round-tools>:first-child:nth-last-child(5){opacity:.4}
.nodo-round-tools>:nth-child(2):nth-last-child(4){opacity:.7}
.nodo-round-text{max-height:88px;overflow:hidden}
.nodo-round-chip{display:inline-flex;align-items:center;align-self:flex-start;gap:6px;height:24px;padding:0 8px 0 6px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:24px}
.nodo-round-menu-item{display:flex;align-items:center;gap:8px;min-width:0}
.nodo-ok{color:var(--dsw-alias-state-success-primary)}.nodo-bad{color:var(--dsw-alias-state-error-primary)}
.nodo-error-line{margin:8px 0;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.nodo-note{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}
/* Feed: the host's scroll padding and flow rhythm — 6px between rows, 12px
   before and after a reply, 16px after a process row. */
.nodo-feedwrap{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;container-type:inline-size}
.nodo-feed{flex:1;min-height:0;overflow-y:auto;padding:16px calc(var(--dsh-composer-side-clearance,16px) + 16px)}
.nodo-feed[data-following]{overflow-anchor:none}
.nodo-feed-inner{display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto}
.nodo-feed-inner>*{min-width:0}
.nodo-feed-inner>*+*{margin-top:6px}
.nodo-feed-inner>*[data-flow=response]+*{margin-top:12px}
.nodo-feed-inner>*[data-flow=process]+*{margin-top:16px}
.nodo-feed-empty{margin:24px 0;text-align:center}
.nodo-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.nodo-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);padding:8px 16px;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}
.nodo-reply{min-width:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-streaming-text{position:relative;min-width:0}
.nodo-streaming-caret{position:absolute;width:2px;margin-left:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary);pointer-events:none;animation:nodo-streaming-pulse 1s ease-in-out infinite}
.nodo-streaming-caret[hidden]{display:none}
@keyframes nodo-streaming-pulse{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){.nodo-streaming-caret{animation:none}}
.nodo-row-content{flex:1;min-width:0}
.nodo-row-content-layout{min-width:0}
.nodo-tool-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.nodo-row-summary{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-row-summary[data-error]{color:var(--dsw-alias-state-error-primary)}
.nodo-request-answer{white-space:pre-wrap;overflow-wrap:anywhere}
.nodo-plan-list{display:flex;flex-direction:column;gap:2px;margin:4px 0 4px 4px;padding:0}
.nodo-plan-step{display:flex;gap:8px;align-items:baseline;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.nodo-plan-mark{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.nodo-plan-step[data-status="in_progress"] .nodo-plan-mark{color:var(--dsw-alias-label-primary)}
.nodo-plan-step[data-status="completed"] .nodo-plan-text{color:var(--dsw-alias-label-tertiary)}
.nodo-plan-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.nodo-think-summary{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.nodo-think-summary[data-streaming]{mask-image:linear-gradient(90deg,black calc(100% - 48px),transparent)}
.nodo-think-body{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-secondary)}
.nodo-image-preview{display:inline-block;max-width:100%;padding:0;border:0;background:transparent;color:inherit;cursor:zoom-in}
.nodo-image-preview:disabled{cursor:wait}
.nodo-io-card{margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}
.nodo-io-section{display:grid;grid-template-columns:max-content 1fr;align-items:baseline;column-gap:16px;max-height:150px;padding:12px 16px;overflow-y:auto}
.nodo-io-label{align-self:start;position:sticky;top:0;color:var(--dsw-alias-label-caption)}
.nodo-io-text{min-width:0;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.nodo-io-text[data-error]{color:var(--dsw-alias-state-error-primary)}
.nodo-turn-error{display:grid;grid-template-columns:10px minmax(0,1fr);align-items:start;gap:8px;padding:2px 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));overflow-wrap:anywhere}
.nodo-turn-error-dot{margin-top:5px}
.nodo-turn-error-title{margin-right:6px;color:var(--dsw-alias-state-error-primary);font-weight:600}
.nodo-tobottom{position:absolute;z-index:8;bottom:16px;right:max(calc(var(--dsh-composer-side-clearance,16px) + 16px),calc((100% - var(--dsh-chat-content-width,748px))/2));display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;border-radius:100px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:var(--dsw-elevation-panel);cursor:pointer}
.nodo-tobottom:hover{background:var(--dsw-alias-button-floating-hover)}
.nodo-turnrail{position:absolute;z-index:7;top:50%;right:12px;transform:translateY(-50%);width:28px;max-height:min(max(0px,calc(100% - 64px)),420px);contain:layout;cursor:pointer;pointer-events:auto}
.nodo-turnrail-scroller{position:relative;max-height:inherit;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none}
.nodo-turnrail-scroller::-webkit-scrollbar{display:none}
.nodo-turnrail-fade-top{mask-image:linear-gradient(transparent 0,black 24px 100%)}
.nodo-turnrail-fade-bottom{mask-image:linear-gradient(black 0 calc(100% - 24px),transparent 100%)}
.nodo-turnrail-fade-top.nodo-turnrail-fade-bottom{mask-image:linear-gradient(transparent 0,black 24px calc(100% - 24px),transparent 100%)}
.nodo-turnrail-marks{position:relative;padding:6px 0}
.nodo-turnmark{position:relative;display:block;width:100%;height:10px;padding:0;border:0;border-radius:8px;background:0 0;cursor:pointer}
.nodo-turnmark:before{content:'';position:absolute;top:50%;right:0;width:20px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l4);transform-origin:100%;transform:translateY(-50%) scaleX(.6);transition:transform .14s,background-color .14s}
.nodo-turnmark-preview:before{background:var(--dsw-alias-label-tertiary);transform:translateY(-50%) scaleX(.9)}
.nodo-turnmark-busy:before{animation:nodo-turn-busy 1s ease-in-out infinite}
.nodo-turnmark-active:before{background:var(--dsw-alias-label-primary);transform:translateY(-50%) scaleX(1)}
.nodo-turnmark:focus-visible{outline:none}
.nodo-turnmark:focus-visible:before{background:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));transform:translateY(-50%) scaleX(1)}
.nodo-turnpreview{position:absolute;z-index:1;right:calc(100% + 10px);top:clamp(0px,calc(var(--nodo-preview-center,0px) - 50px),calc(100% - 100px));box-sizing:border-box;width:min(300px,calc(100cqw - 120px));max-height:100px;padding:8px 12px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);overflow:hidden;pointer-events:none;transition:top .14s cubic-bezier(.2,.8,.2,1);animation:nodo-turn-preview-enter .12s ease-out}
.nodo-turnpreview-prompt,.nodo-turnpreview-response{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.nodo-turnpreview-prompt{font-size:13px;font-weight:600;line-height:18px;-webkit-line-clamp:1}
.nodo-turnpreview-response{margin-top:4px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px;-webkit-line-clamp:3}
@keyframes nodo-turn-preview-enter{0%{opacity:0;transform:translate(4px)}to{opacity:1;transform:translate(0)}}
@keyframes nodo-turn-busy{0%,to{opacity:1}50%{opacity:.35}}
@container (max-width:900px){.nodo-turnrail{display:none}}
@media (prefers-reduced-motion:reduce){.nodo-turnrail-scroller,.nodo-turnmark:before,.nodo-turnpreview,.nodo-chevron{transition:none;animation:none;scroll-behavior:auto}}
/* A pending request is the host's own composer takeover, values copied from
   ApprovalPanel.module.css and QuestionComposer.module.css. */
.nodo-approval{display:flex;flex-direction:column;align-items:center;padding:8px calc(var(--dsh-composer-side-clearance,16px) + 16px) 12px}
.nodo-approval-card{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,748px);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}
.nodo-approval-strip{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--dsw-alias-state-warn-tertiary);color:${WARN_INK};font-size:13px;line-height:18px}
.nodo-approval-from{display:inline-flex;align-items:center;gap:6px;min-width:0}
.nodo-approval-from>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-approval-body{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;max-height:var(--dsh-composer-text-max-height,336px);padding:12px 16px 0;overflow-y:auto;outline:none}
.nodo-approval-headline{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px;text-wrap:pretty}
.nodo-approval-command{margin:0;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;word-break:break-all}
.nodo-approval-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px}
.nodo-approval-reject:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}
.nodo-approval-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nodo-question-frame{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,16px) + 16px) 8px}
.nodo-question-card{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,748px);max-height:min(60vh,520px);padding:0 0 12px;border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-panel);overflow:hidden}
.nodo-question-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 24px}
.nodo-question-eyebrow{color:var(--dsw-alias-label-tertiary);margin-bottom:5px;font-size:12px;line-height:16px}
.nodo-question-title{margin:0;font-size:15px;font-weight:500;line-height:24px;text-wrap:pretty}
.nodo-question-body{display:flex;flex-direction:column;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.nodo-question-options{display:flex;flex-direction:column;gap:1px;margin:8px 0 0;padding:4px 12px}
.nodo-question-option{display:flex;align-items:flex-start;gap:8px;flex-shrink:0;width:100%;min-height:40px;padding:8px 12px 8px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-md);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s,border-color .12s}
.nodo-question-option:hover:not(:disabled),.nodo-question-option[data-selected]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-question-option[data-selected]{border-color:var(--dsw-alias-border-l2)}
.nodo-question-option:disabled{cursor:default}
.nodo-question-number{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;margin-top:2px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.nodo-question-copy{flex:1;min-width:0}
.nodo-question-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px}
.nodo-question-label{font-size:14px;font-weight:500;line-height:24px}
.nodo-question-description{color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:24px}
.nodo-question-answer{box-sizing:border-box;min-height:64px;max-height:144px;margin:8px 12px 0;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:24px;resize:none;outline:none;overflow-y:auto}
.nodo-question-answer:focus{border-color:var(--dsw-alias-state-business-primary)}
.nodo-question-answer::placeholder{color:var(--dsw-alias-label-caption)}
.nodo-question-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding:0 12px 0 18px}
.nodo-question-pager{display:flex;align-items:center;gap:6px;flex-shrink:0}
.nodo-question-progress{color:var(--dsw-alias-label-secondary);white-space:nowrap;word-spacing:-2px;padding:0 4px;font-size:14px;font-weight:500;line-height:24px}
.nodo-question-icon{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-question-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-question-icon:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.nodo-question-feedback{flex:1;min-height:16px;margin:0;color:var(--dsw-alias-state-error-primary);text-align:right;font-size:12px;line-height:16px}
.nodo-question-actions{display:flex;flex-shrink:0;align-items:center;gap:12px}
.nodo-composer{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:12px;flex:none;width:calc(100% - 32px);max-width:calc(var(--dsh-chat-content-width,748px) + 32px);margin:0 auto 4px;padding-top:8px;border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.nodo-composer-scroll{max-height:var(--dsh-composer-text-max-height,336px);margin-right:4px;overflow-y:auto}
.nodo-pending{display:flex;flex-direction:column;gap:4px;max-height:160px;margin:0 8px;padding-bottom:8px;overflow-y:auto;border-bottom:1px solid var(--dsw-alias-border-l2)}
.nodo-pending-item{display:flex;align-items:center;gap:12px;min-width:0;padding:6px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:20px}
.nodo-pending-text{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nodo-pending-images{color:var(--dsw-alias-label-caption)}
.nodo-pending-actions{display:flex;flex:none;align-items:center;gap:8px}
.nodo-pending-actions button,.nodo-pending-stop{padding:2px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.nodo-pending-actions button:hover:not(:disabled),.nodo-pending-stop:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.nodo-pending-actions button:disabled,.nodo-pending-stop:disabled{opacity:.5;cursor:default}
.nodo-pending-stop{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%}
.nodo-composer textarea{box-sizing:border-box;display:block;width:100%;min-height:36px;padding:4px 8px 0 12px;border:0;outline:none;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;caret-color:var(--dsw-alias-state-business-primary);resize:none}
.nodo-composer textarea::placeholder{color:var(--dsw-alias-label-caption)}
/* The caret marks focus in the text surface; the page's control ring stays off it. */
.nodo-page .nodo-composer textarea:focus-visible{outline:none}
.nodo-composer-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;min-width:0;padding:2px 8px 6px}
.nodo-composer-tools{display:flex;align-items:center;gap:12px;min-width:0;margin-right:auto}
.nodo-composer-files{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px;max-height:90px;overflow:auto}
.nodo-user-files{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.nodo-composer-file{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:12px}
.nodo-composer-file>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nodo-composer-file button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}
.nodo-attachment{display:block;max-width:100%;max-height:320px;margin-top:6px;border-radius:var(--dsw-radius-panel)}
.nodo-send{display:grid;place-items:center;flex:none;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;transform:translateY(-2px);transition:background-color .1s}
.nodo-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.nodo-send:disabled{opacity:.4;cursor:default}
/* The statistics line under the input card is the host chat's own pill row: one
   centered line of muted 12px groups, each with a small glyph, the whole line a
   button that opens the session statistics dialog. The row is drawn even when
   the session has no figures yet, so the input card keeps its place. */
.nodo-stats{display:flex;justify-content:center;flex:none;min-height:22px;width:calc(100% - 32px);max-width:calc(var(--dsh-chat-content-width,748px) + 32px);margin:0 auto 6px}
.nodo-stats-pill{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 16px;max-width:100%;padding:2px 8px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-caption);font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;cursor:pointer}
.nodo-stats-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.nodo-stats-pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.nodo-stats-group{display:inline-flex;align-items:center;gap:5px;min-width:0;white-space:nowrap}
.nodo-stats-group svg{flex:none;opacity:.85}
/* A turn's own usage sits under its reply as the host chat's caption. */
.nodo-msg-time{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.nodo-reply-foot{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}
.nodo-turn-usage{margin-top:2px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
/* The dialog the line opens: the host chat's statistics sections and label/value
   rows, label left in the secondary colour, value right and tabular. */
.nodo-stats-section{display:flex;flex-direction:column;gap:6px}
.nodo-stats-heading{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.nodo-stats-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;font-size:13px;line-height:20px}
.nodo-stats-row-label{color:var(--dsw-alias-label-secondary)}
.nodo-stats-row-value{min-width:0;text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
/* The add menu copies the model trigger's secondary-button metrics; the context
   dialog lists files with the host row hover. */
.nodo-add{position:absolute;z-index:100;top:auto;bottom:calc(100% + 4px);left:0;right:0;min-width:0;max-width:100%;max-height:min(400px,var(--nodo-add-space,100vh))}
.nodo-add-anchor{position:static}
.nodo-file-anchor{position:absolute;inset:0;pointer-events:none}
.nodo-file-anchor .nodo-add{pointer-events:auto}
.nodo-file-slot{display:none}
.nodo-add-row{display:flex;align-items:baseline;gap:4px;min-width:0;width:100%}
.nodo-add-name{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-add-alias{flex:none;max-width:20%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-add-desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-add-trigger{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.nodo-add-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* The model picker copies the host composer's model trigger and its drill menu
   cells (dsh-client-ui-model-selection): a 28px secondary trigger with the
   level dimmed, rows label-left / value-right, the chevron flipping when open. */
.nodo-model{display:inline-flex;flex:none;min-width:0;max-width:min(360px,100%)}
.nodo-model-list{width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px)}
.nodo-model-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:100%;height:28px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:400;line-height:20px;cursor:pointer}
.nodo-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-model-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.nodo-model-label,.nodo-model-effort{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-model-effort{flex-shrink:1000;color:var(--dsw-alias-label-caption)}
.nodo-model-icon{display:none;flex:none}
.nodo-composer-row[data-model-compact] .nodo-model-icon{display:block}
.nodo-composer-row[data-model-compact] :is(.nodo-model-label,.nodo-model-effort){display:none}
.nodo-model-cell{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.nodo-model-cell-label{flex:none;white-space:nowrap}
.nodo-model-cell-value{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary)}
.nodo-model-cell-chev{display:inline-flex;flex:none;color:var(--dsw-alias-menu-icon)}
.nodo-role-seat{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:160px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-role-seat-trigger{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:28px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer}
.nodo-role-seat-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-role-seat-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-role-seat-trigger:disabled{cursor:default}
.nodo-role-seat-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.nodo-role-seat-fixed{height:28px;padding:0 6px}
.nodo-role-seat-list{min-width:180px;max-width:min(320px,100vw - 32px);max-height:min(360px,100vh - 96px);overflow-y:auto}
/* The permission control is the host's own PermissionSelect: values copied from
   its compiled PermissionSelect.module.css (dsh-client-ui-permission-presets). */
.nodo-perm{display:inline-flex;flex:none}
.nodo-perm-trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}
.nodo-perm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-perm-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.nodo-perm-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.nodo-perm-icon{flex:none;display:inline-flex}
.nodo-perm-icon svg{width:14px;height:14px}
.nodo-perm-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.nodo-perm-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:inline-flex}
.nodo-perm-chevron-open{transform:rotate(180deg)}
@container (width<=460px){.nodo-perm-trigger:has(.nodo-perm-icon) .nodo-perm-label{display:none}}
.nodo-empty{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:80px;padding:0 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.nodo-headline{font-size:26px;font-weight:500;line-height:32px;color:var(--dsw-alias-label-primary);text-wrap:balance}
/* The compact factory body must let upward menus and shadows overflow.
   Host CSS module class names differ between Web and Desktop builds. */
.nodo-welcome{display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;min-height:0;padding:24px 16px;box-sizing:border-box}
.nodo-welcome [data-conversation-content][data-content-phase=hero]>[data-conversation-scroll]{overflow:visible}
.nodo-welcome-body{display:flex;flex-direction:column;gap:20px;width:min(calc(clamp(680px,(100% + 32px) * .64,920px) + 64px),100%)}
.nodo-welcome-hero{margin:0;display:flex;flex-direction:column;align-items:center}
.nodo-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.nodo-field>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.nodo-field-required{margin-left:2px;color:var(--dsw-alias-state-error-primary)}
/* Every form in the panel is the host's modal, settings included. The card, the
   input metrics and the field rhythm below are the host's own values
   (Modal.module.css, settings-form/fields.module.css). The modal is portaled out
   of .nodo-page, so these rules stay unscoped. */
.nodo-dialog{width:min(440px,100%);max-height:100%}
.nodo-dialog *{box-sizing:border-box}
.nodo-dialog-fields{display:flex;flex-direction:column;max-height:min(60vh,520px);overflow-y:auto}
.nodo-dialog .nodo-field{gap:6px;padding:12px 0}
.nodo-dialog .nodo-field:first-child{padding-top:0}
.nodo-dialog .nodo-field+.nodo-field{border-top:.5px solid var(--dsw-alias-border-l2)}
/* A row keeps the field rhythm: the row draws the separator and its own fields
   drop the per-field padding and hairline. */
.nodo-dialog-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-dialog-row>.nodo-field,.nodo-dialog-row>.nodo-field+.nodo-field{padding:0;border-top:0}
.nodo-dialog-fields>.nodo-dialog-row:first-child{border-top:0;padding-top:0}
.nodo-dialog-row+.nodo-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-dialog .nodo-field>span{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.nodo-dialog-input{width:100%;height:44px;padding:7px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:400;line-height:22px;outline:none}
.nodo-dialog-input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.nodo-dialog-input:disabled{color:var(--dsw-alias-label-dimmed)}
.nodo-dialog-select{padding-right:32px}
/* Windows paints the native select popup with the OS light background while the
   transparent select contributes none: without option colors of their own, the
   dark theme's white labels vanish on it. */
.nodo-dialog-select option{background-color:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.nodo-dialog-textarea{height:auto;min-height:88px;padding:12px;resize:vertical}
.nodo-dialog-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.nodo-dialog-pick{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.nodo-dialog-path{margin:0;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.nodo-dialog-leading{margin-right:auto}
.nodo-dialog-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nodo-dialog-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.nodo-dialog-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.nodo-dialog :is(.nodo-ok,.nodo-bad,.nodo-dialog-status){margin:0}
.nodo-role-dialog{--nodo-role-radius:var(--dsw-radius-md)}
.nodo-role-dialog button{border-radius:var(--nodo-role-radius)}
.nodo-role-dialog .nodo-field,.nodo-role-dialog .nodo-field+.nodo-field{padding:0;border:0;gap:6px}
.nodo-role-dialog .nodo-field>span{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.nodo-role-dialog .nodo-dialog-input{height:36px;padding:8px 12px;border-radius:var(--nodo-role-radius);font-size:13px;line-height:22px}
.nodo-role-dialog .nodo-dialog-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nodo-role-dialog .nodo-dialog-select{padding-right:28px}
.nodo-role-dialog .nodo-dialog-error{margin:0}
.nodo-role-editor{display:flex;flex-direction:column;gap:16px}
.nodo-role-editor{gap:28px}
.nodo-role-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nodo-role-hero{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;padding:8px 0 4px}
.nodo-role-name,.nodo-role-summary{box-sizing:border-box;width:100%;border:0;border-radius:8px;background:0 0;color:inherit;font:inherit;text-align:center}
.nodo-role-name{max-width:360px;height:40px;padding:0 8px;font-size:24px;font-weight:600}
.nodo-role-summary{max-width:560px;height:32px;padding:0 8px;color:var(--dsw-alias-label-secondary);font-size:14px}
:is(.nodo-role-name,.nodo-role-summary):is(:hover,:focus):not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:0}
.nodo-role-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 12px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.nodo-role-engine{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px 0 8px;border-radius:13px;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:500}
.nodo-role-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.nodo-role-sec{display:flex;flex-direction:column;gap:8px}
.nodo-role-sec>h3{margin:0;padding:0 4px;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500}
.nodo-role-run,.nodo-role-identity-panel{display:flex;flex-direction:column;overflow:hidden;border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.nodo-role-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;min-height:60px;padding:0 20px 0 24px}
.nodo-role-row+.nodo-role-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-role-row>.nodo-dialog-hint{flex-basis:100%;text-align:right}
.nodo-role-label{font-size:14px;font-weight:500}
.nodo-role-dialog .nodo-role-select{width:auto;min-width:200px;max-width:320px;height:36px;border-radius:10px}
.nodo-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.nodo-seg>button{display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:30px;padding:0 12px;border:0;border-radius:9px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;font-weight:500;white-space:nowrap;cursor:pointer}
.nodo-seg>button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.nodo-seg>button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.nodo-seg>button:disabled{opacity:.5;cursor:default}
.nodo-role-identity-panel{gap:14px;padding:18px 20px 20px 24px}
.nodo-role-text{position:relative}
.nodo-role-count{position:absolute;right:28px;bottom:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;pointer-events:none}
.nodo-role-tbox{overflow:hidden;border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.nodo-role-tbox:focus-within{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary)}
.nodo-role-textarea{display:block;box-sizing:border-box;width:100%;height:156px;padding:14px 16px;border:0;outline:0;background:0 0;color:inherit;font:inherit;font-size:14px;line-height:22px;resize:vertical}
.nodo-role-tbox>.nodo-templates{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-role-tbox>.nodo-identity-save{margin:0 12px 10px}
.nodo-role-avatar-slot{position:relative;flex:none}
.nodo-role-dialog .nodo-role-avatar{--av-r:calc(104px*18/64);position:relative;display:inline-flex;align-items:center;justify-content:center;width:104px;height:104px;padding:0;border:0;border-radius:var(--av-r);background:0 0;cursor:pointer}
.nodo-role-avatar>.nodo-avatar{overflow:hidden;border-radius:var(--av-r)}
.nodo-role-dialog .nodo-role-avatar::before{content:'';position:absolute;inset:-5px;border:1px solid var(--dsw-alias-border-l1);border-radius:calc(var(--av-r) + 5px);pointer-events:none}
.nodo-role-dialog .nodo-role-avatar:disabled{cursor:default}
.nodo-role-avatar-edit{position:absolute;right:-10px;bottom:-6px;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 0 0 1px var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.nodo-avatar-pop{position:absolute;z-index:20;top:calc(100% + 8px);left:0;width:288px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2)}
.nodo-role-dialog .nodo-avatar-picker{gap:4px}
.nodo-role-dialog .nodo-avatar-option{gap:4px;min-height:68px;padding:8px 2px;border-radius:var(--nodo-role-radius)}
.nodo-role-actions{display:flex;align-items:center;gap:8px;flex:none}
.nodo-role-dialog .nodo-role-more{width:32px;height:32px;color:var(--dsw-alias-label-secondary)}
.nodo-role-dialog .nodo-role-more:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-role-confirm-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 8px 8px 16px;border-radius:calc(var(--nodo-role-radius) + 4px);background:var(--dsw-alias-bg-layer-1)}
.nodo-role-confirm{flex:1;margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
:is(.nodo-template-pick,.nodo-text-button,.nodo-roles-order):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-templates-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.nodo-template{position:relative;min-width:0}
.nodo-role-dialog .nodo-template-pick{display:flex;align-items:center;height:28px;padding:0 12px;border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.nodo-template[data-saved] .nodo-template-pick{padding-right:26px}
.nodo-template-pick:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-template-pick[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary)}
.nodo-template-pick:disabled{opacity:.5;cursor:default}
.nodo-template-name{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-role-dialog .nodo-template-remove{position:absolute;top:5px;right:5px;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-template-remove{opacity:0}
.nodo-template:is(:hover,:focus-within) .nodo-template-remove{opacity:1}
.nodo-template-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.nodo-templates-divider{width:1px;height:22px;background:var(--dsw-alias-border-l2)}
.nodo-template-filled{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-template-filled>.nodo-text-button{height:24px;padding:0 6px}
.nodo-dialog-counted{position:relative}
.nodo-dialog-counted>.nodo-dialog-input{padding-right:64px}
.nodo-dialog-count{position:absolute;right:12px;bottom:9px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;pointer-events:none}
.nodo-role-dialog .nodo-dialog-counted>.nodo-dialog-textarea{height:260px;min-height:112px;padding:12px 12px 30px;resize:vertical}
.nodo-identity-save{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-layer-1)}
.nodo-identity-save>.nodo-dialog-hint{grid-column:1/-1}
.nodo-role-dialog .nodo-identity-save .nodo-dialog-input{height:34px}
.nodo-role-notice{margin:0;padding:8px 12px;border-radius:var(--nodo-role-radius);background:var(--dsw-alias-state-warn-tertiary);color:${WARN_INK};font-size:12px;line-height:18px}
.nodo-permission-select{position:relative;display:flex;align-items:center;min-width:0}
.nodo-permission-select>.nodo-perm-icon{position:absolute;left:10px;pointer-events:none}
.nodo-permission-select>.nodo-perm-icon+.nodo-dialog-select{padding-left:32px}
@media(max-width:640px){.nodo-role-row{padding:12px 16px}.nodo-role-identity-panel{padding:16px}}
.nodo-worktree-toggle{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.nodo-worktree-toggle input{accent-color:var(--dsw-alias-state-business-primary)}
.nodo-worktree-modes{display:flex;align-items:center;gap:6px}
.nodo-branch-input{display:flex;align-items:center;gap:4px}
.nodo-branch-input .nodo-dialog-input{flex:1;min-width:0;width:auto}
.nodo-branch-toggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:44px;padding:0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-branch-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-engine-dialog{--nodo-engine-radius:var(--dsw-radius-md);width:min(800px,100%);gap:16px;padding-bottom:16px;border-radius:calc(var(--nodo-engine-radius) + 16px)}
.nodo-engine-dialog button{border-radius:var(--nodo-engine-radius)}
.nodo-engine-dialog h2{font-size:18px;font-weight:600;line-height:26px}
.nodo-engine-shell>div:first-child{padding-top:16px;padding-bottom:8px}
.nodo-engine-shell>p{font-size:12px;line-height:18px}
.nodo-engine-shell,.nodo-engine-shell>div:last-child{min-height:0}
.nodo-engine-shell>div:last-child{margin-top:12px}
.nodo-engine-dialog>:last-child{flex-shrink:0}
.nodo-engine-content{max-height:min(66vh,720px);overflow-y:auto;overscroll-behavior:contain;margin:0 -12px 0 -2px;padding:0 12px 2px 2px}
.nodo-engine-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.nodo-engine-toolbar>.nodo-engine-group{margin:0}
.nodo-engine-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;align-items:stretch}
.nodo-engine-group{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nodo-engine-group>span{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.nodo-engine-card{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.nodo-engine-dialog .nodo-engine-card{border-radius:calc(var(--nodo-engine-radius) + 10px)}
.nodo-engine-card[data-expanded]{grid-column:1/-1;border-color:var(--dsw-alias-border-l4)}
.nodo-engine-card[data-muted] .nodo-engine-mark,.nodo-engine-card[data-muted] .nodo-engine-name strong{opacity:.5}
.nodo-engine-row{display:flex;align-items:center;gap:8px}
.nodo-engine-toggle{display:flex;align-items:center;gap:12px;flex:1;min-width:0;min-height:58px;padding:0 8px 0 9px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-engine-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-engine-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-3px;border-radius:var(--dsw-radius-lg)}
.nodo-engine-toggle:disabled{cursor:default}
.nodo-engine-dialog .nodo-engine-toggle{border-radius:0}
.nodo-engine-mark{display:grid;place-items:center;flex:none;width:34px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}
.nodo-engine-dialog .nodo-engine-mark{width:40px;height:40px;border-radius:var(--nodo-engine-radius)}
.nodo-engine-name{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.nodo-engine-name strong{display:block;font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nodo-engine-caption{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nodo-engine-caption[data-bad]{color:var(--dsw-alias-state-error-primary)}
.nodo-engine-toggle .nodo-chevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-engine-switch{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;margin-right:12px;padding:0;border:1.5px solid var(--dsw-alias-border-l3);border-radius:50%;background:transparent;color:var(--dsw-alias-bg-base);cursor:pointer}
.nodo-engine-switch:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.nodo-engine-switch[aria-pressed=true],.nodo-engine-pick[aria-pressed=true] .nodo-engine-switch{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}
.nodo-engine-dialog .nodo-engine-switch{position:relative;width:34px;height:20px;margin:0 19px 0 8px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);transition:background .15s}
.nodo-engine-dialog .nodo-engine-switch[aria-pressed=true]{background:var(--dsw-alias-state-business-primary)}
.nodo-engine-dialog .nodo-engine-switch:disabled{opacity:.5;cursor:default}
.nodo-engine-dialog .nodo-engine-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-soft);transition:transform .15s}
.nodo-engine-dialog .nodo-engine-switch[aria-pressed=true]::after{transform:translateX(14px)}
.nodo-engine-pick{display:flex;align-items:center;gap:8px;width:100%;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.nodo-engine-pick:hover:not(:disabled),.nodo-engine-pick[aria-pressed=true]{border-color:var(--dsw-alias-border-l4)}
.nodo-engine-pick[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-onboard-dialog{width:min(760px,100%);gap:16px;padding-bottom:16px}
.nodo-onboard-dialog .nodo-engine-content{height:min(320px,50vh)}
.nodo-engine-detail{margin:0 5px 5px;padding:16px;border-radius:calc(var(--nodo-engine-radius) + 4px);background:var(--dsw-specific-sidebar-fill)}
.nodo-engine-connection{display:flex;justify-content:space-between;align-items:center;gap:12px}
.nodo-engine-connection strong,.nodo-engine-scan strong{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;line-height:20px}
.nodo-engine-connection>button{flex:none}
.nodo-engine-fields{max-height:none;overflow:visible;gap:0}
.nodo-engine-section{margin:16px 0 0;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-engine-fields>.nodo-ok{margin-top:16px}
.nodo-engine-config{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.nodo-engine-dialog .nodo-engine-config>.nodo-field{padding:0;border:0;gap:4px}
.nodo-engine-dialog .nodo-engine-config>.nodo-field>span{font-size:12px}
.nodo-engine-dialog .nodo-dialog-input{height:34px;padding:5px 12px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:20px}
.nodo-engine-section>.nodo-dialog-path{margin-top:6px;font-size:12px}
.nodo-engine-scan{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nodo-engine-scan strong>span{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.nodo-engine-check{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px}
.nodo-engine-check-row{display:grid;grid-template-columns:132px minmax(0,1fr);gap:12px}
.nodo-engine-check dt{display:flex;align-items:baseline;gap:8px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.nodo-engine-check dt>span{flex:none;align-self:center}
.nodo-engine-check dd{margin:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.nodo-engine-check dd.nodo-bad{color:var(--dsw-alias-state-error-primary)}
@media(max-width:640px){.nodo-engine-config{grid-template-columns:minmax(0,1fr)}.nodo-engine-connection{align-items:flex-start;flex-wrap:wrap}.nodo-engine-check-row{grid-template-columns:minmax(0,1fr);gap:2px}.nodo-engine-check dd{padding-left:16px}.nodo-engine-content{max-height:65vh}}
@media(max-width:820px){.nodo-frame{flex-direction:column}.nodo-rail{width:100%;max-height:45%;border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l3)}.nodo-head{padding:10px 50px 0 12px}.nodo-feed{padding:16px}.nodo-composer{width:calc(100% - 24px)}}
`
