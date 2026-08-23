/* ============================================================
   state.js — shared mutable state
   ============================================================ */
window.App = window.App || {};

App.state = {
  files: [],            // {file, displayName, status: wait|proc|done|err, roblox:{status,assetId,operationId,msg,error,moderation}}
  backendUrl: '',
  backendOnline: false,
  hasLoadedTmp: false,
  isRobloxLogged: false,
  actx: null,           // shared AudioContext
  prevSrc: null,
  prevGain: null,
  fallbackAudio: null,
  isPrev: false,
};

// DOM refs diisi main.js setelah DOM siap
App.el = {};
