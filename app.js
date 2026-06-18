/**
 * 俯卧撑助手 - 核心逻辑
 * 功能：传感器计数、训练计划、语音播报、通知提醒
 */

// ===================== 状态管理 =====================
const STATE = {
  // 训练状态
  isTraining: false,
  currentGroup: 0,       // 当前组数 0~3
  currentCount: 0,       // 当前组完成次数
  isResting: false,      // 是否在休息中
  restSeconds: 60,       // 休息倒计时
  restTimer: null,       // 休息定时器
  // 传感器
  sensorActive: false,
  lastCountTime: 0,      // 上次计数时间戳
  // 波形识别状态
  motionState: 'idle',     // idle | going_down | bottom | going_up
  lastZ: 0,
  bottomZ: 999,
  // 数据
  plan: [],              // 本次训练计划 [warm, normal, max, relax]
  groupCounts: [0,0,0,0],// 每组实际完成次数
  // 设置
  sensitivity: 'medium',   // low | medium | high
  reminderTime: '20:00',
  reminderEnabled: false,
  reminderCheckInterval: null,
};

// 灵敏度阈值配置 (Z轴加速度差值)
const THRESHOLD = {
  low: 4.5,
  medium: 3.0,
  high: 1.8,
};

// 组标签
const GROUP_LABELS = ['热身', '常规', '力竭', '放松'];
const GROUP_COLORS = ['#FF9500', '#4CD964', '#FF3B30', '#5AC8FA'];

// ===================== LocalStorage =====================
const Storage = {
  KEY: 'pushup_data_v1',
  get() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { best: 10, total: 0, sessions: 0, lastDate: '' };
  },
  save(data) {
    localStorage.setItem(this.KEY, JSON.stringify(data));
  },
  getSettings() {
    try {
      const raw = localStorage.getItem('pushup_settings_v1');
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { sensitivity: 'medium', reminderTime: '20:00', reminderEnabled: false };
  },
  saveSettings(s) {
    localStorage.setItem('pushup_settings_v1', JSON.stringify(s));
  },
};

// ===================== 语音播报 =====================
const Voice = {
  synth: window.speechSynthesis,
  speak(text, rate = 1.1) {
    if (!this.synth) return;
    // 取消之前的语音
    this.synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    utter.rate = rate;
    utter.pitch = 1;
    this.synth.speak(utter);
  },
  countdown(n) {
    if (n > 0) this.speak(String(n));
    else this.speak('开始！', 1.0);
  },
};

// ===================== 通知 =====================
const Notify = {
  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    const result = await Notification.requestPermission();
    return result === 'granted';
  },
  send(title, body) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '', silent: false });
    }
  },
};

// ===================== DOM 元素缓存 =====================
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ===================== 视图切换 =====================
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
}

// ===================== Toast =====================
function toast(msg, duration = 2000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), duration);
}

// ===================== 首页逻辑 =====================
function renderHome() {
  const data = Storage.get();
  const s = Storage.getSettings();
  STATE.sensitivity = s.sensitivity || 'medium';
  STATE.reminderTime = s.reminderTime || '20:00';
  STATE.reminderEnabled = s.reminderEnabled || false;

  // 生成今日计划
  const best = data.best || 10;
  STATE.plan = [
    Math.max(3, Math.round(best * 0.5)),
    Math.max(5, Math.round(best * 0.8)),
    'MAX',
    Math.max(3, Math.round(best * 0.5)),
  ];

  $('t1').textContent = STATE.plan[0];
  $('t2').textContent = STATE.plan[1];
  $('t3').textContent = 'MAX';
  $('t4').textContent = STATE.plan[3];
  $('stat-best').textContent = best;
  $('stat-total').textContent = data.total || 0;

  // 初始化设置页控件
  initSettingsUI();
}

// ===================== 训练流程 =====================
function startTraining() {
  STATE.isTraining = true;
  STATE.currentGroup = 0;
  STATE.currentCount = 0;
  STATE.groupCounts = [0, 0, 0, 0];
  STATE.isResting = false;

  showView('training');
  showTrainingPanel('prep');
}

function showTrainingPanel(name) {
  ['prep', 'countdown', 'active', 'rest', 'done', 'max-confirm'].forEach(p => {
    $(`training-${p}`).classList.add('hidden');
  });
  $(`training-${name}`).classList.remove('hidden');
}

// 开始传感器监听
async function startSensor() {
  // 请求传感器权限 (iOS 13+)
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') {
        toast('需要传感器权限才能自动计数');
        return;
      }
    } catch (e) {
      toast('无法获取传感器权限');
      return;
    }
  }

  // 检查是否支持
  if (!window.DeviceMotionEvent) {
    toast('您的设备不支持传感器，请手动计数');
    return;
  }

  showTrainingPanel('countdown');
  runCountdown(3, () => {
    startGroup(0);
  });
}

// 倒计时
function runCountdown(seconds, onDone) {
  let n = seconds;
  const el = $('countdown-num');
  el.textContent = n;
  Voice.countdown(n);

  const timer = setInterval(() => {
    n--;
    if (n > 0) {
      el.textContent = n;
      Voice.countdown(n);
    } else if (n === 0) {
      el.textContent = '开始！';
      el.style.fontSize = '60px';
      Voice.countdown(0);
    } else {
      clearInterval(timer);
      el.style.fontSize = '';
      onDone();
    }
  }, 1000);
}

// 开始某一组
function startGroup(groupIndex) {
  STATE.currentGroup = groupIndex;
  STATE.currentCount = 0;
  STATE.isResting = false;
  STATE.sensorActive = true;
  STATE.motionState = 'idle';
  STATE.lastZ = 0;
  STATE.bottomZ = 999;

  showTrainingPanel('active');
  updateActiveDisplay();

  // 启动传感器监听
  window.addEventListener('devicemotion', handleMotion);

  // 力竭组特殊处理
  if (groupIndex === 2) {
    $('group-target').textContent = '不设上限，尽力而为';
  }
}

// 更新训练显示
function updateActiveDisplay() {
  const g = STATE.currentGroup;
  const badge = $('group-badge');
  const target = $('group-target');

  badge.textContent = `第 ${g + 1} 组 · ${GROUP_LABELS[g]}`;
  badge.style.color = GROUP_COLORS[g];
  badge.style.background = GROUP_COLORS[g] + '22';

  if (g === 2) {
    target.textContent = '不设上限，尽力而为';
  } else {
    target.textContent = `目标 ${STATE.plan[g]}`;
  }

  $('count-display').textContent = STATE.currentCount;
}

// ===================== 传感器核心算法 =====================
function handleMotion(event) {
  if (!STATE.sensorActive) return;

  const acc = event.accelerationIncludingGravity;
  if (!acc) return;

  const z = acc.z || 0;
  const threshold = THRESHOLD[STATE.sensitivity] || THRESHOLD.medium;

  // 波形识别算法：
  // idle -> going_down (z 显著减小) -> bottom (最低点附近) -> going_up (z 显著增大) -> 计数+1

  const now = Date.now();
  const debounceMs = 500; // 防抖 0.5 秒

  switch (STATE.motionState) {
    case 'idle':
      // 检测到向下的加速度（身体下降）
      if (z < -threshold && STATE.lastZ !== 0) {
        STATE.motionState = 'going_down';
        STATE.bottomZ = 999;
      }
      break;

    case 'going_down':
      // 持续跟踪最低点
      if (z < STATE.bottomZ) {
        STATE.bottomZ = z;
      }
      // 如果 z 开始回升，说明触底了
      if (z > STATE.bottomZ + 1.0) {
        STATE.motionState = 'bottom';
      }
      break;

    case 'bottom':
      // 等待显著上升
      if (z > threshold) {
        // 完成一次完整波形
        if (now - STATE.lastCountTime > debounceMs) {
          STATE.currentCount++;
          STATE.lastCountTime = now;
          $('count-display').textContent = STATE.currentCount;

          // 达标提示音（非力竭组）
          if (STATE.currentGroup !== 2 && STATE.currentCount === STATE.plan[STATE.currentGroup]) {
            Voice.speak('目标达成');
          }
        }
        STATE.motionState = 'idle';
        STATE.bottomZ = 999;
      }
      break;
  }

  STATE.lastZ = z;
}

// 停止传感器
function stopSensor() {
  STATE.sensorActive = false;
  window.removeEventListener('devicemotion', handleMotion);
}

// 完成当前组
function finishCurrentGroup() {
  stopSensor();
  STATE.groupCounts[STATE.currentGroup] = STATE.currentCount;

  const g = STATE.currentGroup;

  // 力竭组确认
  if (g === 2) {
    showTrainingPanel('max-confirm');
    $('max-confirm-num').textContent = STATE.currentCount;
    return;
  }

  // 如果是最后一组（第4组）
  if (g === 3) {
    finishTraining();
    return;
  }

  // 进入休息
  startRest();
}

// 确认力竭组结束
function confirmMaxGroup() {
  STATE.groupCounts[2] = STATE.currentCount;
  startRest();
}

// 开始休息
function startRest() {
  STATE.isResting = true;
  STATE.restSeconds = 60;

  // 播报
  const groupNum = STATE.currentGroup + 1;
  Voice.speak(`第${groupNum}组结束，休息60秒`);

  showTrainingPanel('rest');

  const nextGroup = STATE.currentGroup + 1;
  const nextLabel = GROUP_LABELS[nextGroup];
  const nextTarget = nextGroup === 2 ? '不设上限' : `目标 ${STATE.plan[nextGroup]}`;
  $('rest-next').textContent = `下一组：${nextLabel} · ${nextTarget}`;

  $('rest-num').textContent = STATE.restSeconds;

  STATE.restTimer = setInterval(() => {
    STATE.restSeconds--;
    $('rest-num').textContent = STATE.restSeconds;

    if (STATE.restSeconds <= 0) {
      clearInterval(STATE.restTimer);
      STATE.restTimer = null;
      STATE.isResting = false;
      Voice.speak('下一组开始');
      startGroup(STATE.currentGroup + 1);
    }
  }, 1000);
}

// 跳过休息
function skipRest() {
  if (STATE.restTimer) {
    clearInterval(STATE.restTimer);
    STATE.restTimer = null;
  }
  STATE.isResting = false;
  Voice.speak('下一组开始');
  startGroup(STATE.currentGroup + 1);
}

// 训练完成
function finishTraining() {
  STATE.isTraining = false;
  showTrainingPanel('done');

  // 计算统计
  const totalDone = STATE.groupCounts.reduce((a, b) => a + b, 0);
  const data = Storage.get();

  // 更新历史最高
  const maxGroup = Math.max(...STATE.groupCounts);
  if (maxGroup > data.best) {
    data.best = maxGroup;
  }
  data.total = (data.total || 0) + totalDone;
  data.sessions = (data.sessions || 0) + 1;
  data.lastDate = new Date().toISOString().split('T')[0];
  Storage.save(data);

  // 渲染完成统计
  const statsEl = $('done-stats');
  statsEl.innerHTML = `
    <div class="done-stats-row"><span class="done-stats-label">总次数</span><span class="done-stats-value">${totalDone}</span></div>
    <div class="done-stats-row"><span class="done-stats-label">第1组 (热身)</span><span class="done-stats-value">${STATE.groupCounts[0]}</span></div>
    <div class="done-stats-row"><span class="done-stats-label">第2组 (常规)</span><span class="done-stats-value">${STATE.groupCounts[1]}</span></div>
    <div class="done-stats-row"><span class="done-stats-label">第3组 (力竭)</span><span class="done-stats-value">${STATE.groupCounts[2]}</span></div>
    <div class="done-stats-row"><span class="done-stats-label">第4组 (放松)</span><span class="done-stats-value">${STATE.groupCounts[3]}</span></div>
  `;
}

// 用户确认完成状态
function onDoneResult(completed) {
  const data = Storage.get();
  let best = data.best || 10;

  if (completed) {
    // 完成目标，基数 +10%
    best = Math.round(best * 1.1);
    toast('太棒了！下次训练强度已提升 10%');
  } else {
    // 未完成，基数 -10%
    best = Math.max(5, Math.round(best * 0.9));
    toast('没关系，下次训练强度已适度下调');
  }

  data.best = best;
  Storage.save(data);

  // 返回首页
  renderHome();
  showView('home');
}

// 退出训练（中途）
function exitTraining() {
  stopSensor();
  if (STATE.restTimer) {
    clearInterval(STATE.restTimer);
    STATE.restTimer = null;
  }
  STATE.isTraining = false;
  showView('home');
  renderHome();
}

// ===================== 设置页逻辑 =====================
function initSettingsUI() {
  // 灵敏度按钮
  $$('.sens-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sens === STATE.sensitivity);
  });

  // 提醒控件
  $('reminder-time').value = STATE.reminderTime;
  $('reminder-toggle').checked = STATE.reminderEnabled;
  updateReminderStatus();

  // 启动/停止提醒检查
  setupReminderCheck();
}

function setSensitivity(level) {
  STATE.sensitivity = level;
  $$('.sens-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sens === level);
  });
  const s = Storage.getSettings();
  s.sensitivity = level;
  Storage.saveSettings(s);
  toast(`灵敏度已设为：${level === 'low' ? '低' : level === 'medium' ? '中' : '高'}`);
}

function updateReminderStatus() {
  const enabled = $('reminder-toggle').checked;
  const status = $('reminder-status');
  if (enabled) {
    status.textContent = `每天 ${$('reminder-time').value} 提醒您训练`;
    status.style.color = '#4CD964';
  } else {
    status.textContent = '未开启';
    status.style.color = '#8E8E93';
  }
}

async function toggleReminder(enabled) {
  if (enabled) {
    const granted = await Notify.requestPermission();
    if (!granted) {
      $('reminder-toggle').checked = false;
      toast('通知权限被拒绝，无法开启提醒');
      updateReminderStatus();
      return;
    }
  }
  STATE.reminderEnabled = enabled;
  STATE.reminderTime = $('reminder-time').value;
  const s = Storage.getSettings();
  s.reminderEnabled = enabled;
  s.reminderTime = STATE.reminderTime;
  Storage.saveSettings(s);
  updateReminderStatus();
  setupReminderCheck();
  toast(enabled ? '每日提醒已开启' : '每日提醒已关闭');
}

function setupReminderCheck() {
  if (STATE.reminderCheckInterval) {
    clearInterval(STATE.reminderCheckInterval);
    STATE.reminderCheckInterval = null;
  }

  if (!STATE.reminderEnabled) return;

  // 每分钟检查一次
  STATE.reminderCheckInterval = setInterval(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const current = `${hh}:${mm}`;
    if (current === STATE.reminderTime) {
      Notify.send('俯卧撑助手', '该做俯卧撑了！💪');
    }
  }, 60000);
}

function resetAllData() {
  if (!confirm('确定要重置所有数据吗？此操作不可撤销。')) return;
  localStorage.removeItem(Storage.KEY);
  localStorage.removeItem('pushup_settings_v1');
  toast('所有数据已重置');
  renderHome();
}

// ===================== Service Worker =====================
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('SW registered'))
      .catch(err => console.error('SW failed', err));
  }
}

// ===================== 事件绑定 =====================
function bindEvents() {
  // 首页
  $('btn-start').addEventListener('click', startTraining);
  $('btn-settings').addEventListener('click', () => showView('settings'));

  // 训练页
  $('btn-start-sensor').addEventListener('click', startSensor);
  $('btn-finish-group').addEventListener('click', finishCurrentGroup);
  $('btn-skip-rest').addEventListener('click', skipRest);
  $('btn-exit-training').addEventListener('click', exitTraining);

  // 力竭组确认
  $('btn-max-done').addEventListener('click', confirmMaxGroup);
  $('btn-max-continue').addEventListener('click', () => {
    showTrainingPanel('active');
    STATE.sensorActive = true;
    STATE.motionState = 'idle';
    window.addEventListener('devicemotion', handleMotion);
  });

  // 训练完成
  $('btn-done-yes').addEventListener('click', () => onDoneResult(true));
  $('btn-done-no').addEventListener('click', () => onDoneResult(false));

  // 设置页
  $('btn-back-home').addEventListener('click', () => { showView('home'); renderHome(); });
  $$('.sens-btn').forEach(btn => {
    btn.addEventListener('click', () => setSensitivity(btn.dataset.sens));
  });
  $('reminder-toggle').addEventListener('change', (e) => toggleReminder(e.target.checked));
  $('reminder-time').addEventListener('change', (e) => {
    STATE.reminderTime = e.target.value;
    const s = Storage.getSettings();
    s.reminderTime = e.target.value;
    Storage.saveSettings(s);
    updateReminderStatus();
  });
  $('btn-reset-data').addEventListener('click', resetAllData);
}

// ===================== 初始化 =====================
function init() {
  renderHome();
  bindEvents();
  registerSW();

  // 检查是否需要初始化数据
  const data = Storage.get();
  if (!data.best) {
    Storage.save({ best: 10, total: 0, sessions: 0, lastDate: '' });
  }

  // 页面可见性变化时暂停/恢复传感器
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && STATE.sensorActive) {
      window.removeEventListener('devicemotion', handleMotion);
    } else if (!document.hidden && STATE.sensorActive && STATE.isTraining) {
      window.addEventListener('devicemotion', handleMotion);
    }
  });
}

// 启动
document.addEventListener('DOMContentLoaded', init);
