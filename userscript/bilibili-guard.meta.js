// ==UserScript==
// @name         B站大航海详情
// @namespace    https://github.com/EchoXiaoze/bilibili-guard-extension
// @version      0.3.1.14
// @description  在B站视频页和个人空间按需显示当前创作者的大航海详情。
// @match        https://www.bilibili.com/video/*
// @match        https://space.bilibili.com/*
// @connect      api.bilibili.com
// @connect      api.live.bilibili.com
// @connect      api.gscn.live
// @connect      echoxiaoze.github.io
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getResourceURL
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @resource     guardFrameCaptain https://echoxiaoze.github.io/bilibili-guard-extension-dist/assets/frames/captain.png#sha256=adc6dfa31e752bcb12c792d5bdeac67f822ce854b899806c5bab4dbd3b433c34
// @resource     guardFrameAdmiral https://echoxiaoze.github.io/bilibili-guard-extension-dist/assets/frames/admiral.png#sha256=54237824da6540cdf77c8df1ecf373f9440c83ad7d457388134d2de67303407f
// @resource     guardFrameGovernor https://echoxiaoze.github.io/bilibili-guard-extension-dist/assets/frames/governor.png#sha256=240d61edc2a17b7909c488b69a497ad4437699d1a86539bfb5c7838bf25e7a39
// @updateURL    https://echoxiaoze.github.io/bilibili-guard-extension-dist/userscript/bilibili-guard.meta.js
// @downloadURL  https://echoxiaoze.github.io/bilibili-guard-extension-dist/userscript/bilibili-guard.user.js
// @run-at       document-idle
// ==/UserScript==
