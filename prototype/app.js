const state = {
  activePage: "today",
  addType: "task",
  tasks: [
    { time: "09:30", title: "整理项目需求", meta: "工作 · 45 分钟", status: "done" },
    { time: "13:30", title: "午休和散步", meta: "健康 · 30 分钟", status: "planned" },
    { time: "19:00", title: "准备明天的早餐", meta: "生活 · 20 分钟", status: "planned" },
  ],
};

const pageRoot = document.querySelector("#page-root");
const modal = document.querySelector("#add-modal");
const quickInput = document.querySelector("#quick-input");
const quickHint = document.querySelector("#quick-hint");

function escapeText(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function renderToday() {
  const taskMarkup = state.tasks.map((task, index) => `
    <article class="timeline-item ${index === 1 ? "is-current" : ""}">
      <span class="timeline-dot" aria-hidden="true"></span>
      <span class="timeline-time">${escapeText(task.time)}</span>
      <div>
        <p class="timeline-title">${escapeText(task.title)}</p>
        <p class="timeline-meta">${escapeText(task.meta)}</p>
      </div>
      <button class="task-action ${task.status === "done" ? "is-done" : ""}" data-task-index="${index}" type="button">
        ${task.status === "done" ? "已完成" : index === 1 ? "开始" : "完成"}
      </button>
    </article>
  `).join("");

  pageRoot.innerHTML = `
    <header class="page-heading">
      <div><span class="eyebrow">星期二 · 9 月 15 日</span><h1>今天，慢一点也没关系。</h1></div>
      <p class="heading-note">先完成眼前的一件事。剩下的计划，可以根据真实状态调整。</p>
    </header>
    <div class="section-grid">
      <section class="surface" aria-labelledby="timeline-title">
        <div class="surface-header"><div><span class="eyebrow">今日时间线</span><h2 id="timeline-title">接下来</h2></div><span class="tag">3 项安排</span></div>
        <div class="timeline">${taskMarkup}</div>
      </section>
      <aside class="surface" aria-labelledby="summary-title">
        <div class="surface-header"><div><span class="eyebrow">今天的状态</span><h2 id="summary-title">留一点余地</h2></div></div>
        <div class="surface-body">
          <div class="summary-list">
            <div class="summary-row"><span>计划时长</span><strong>1h 35m</strong></div>
            <div class="summary-row"><span>已完成</span><strong>1 / 3</strong></div>
            <div class="summary-row"><span>计划负荷</span><strong>58%</strong></div>
          </div>
          <div class="insight"><strong>今天安排得刚好</strong><p>晚上还有一段空白时间，可以留给临时变化或休息。</p><div class="progress-line" aria-label="计划负荷 58%" role="progressbar" aria-valuenow="58" aria-valuemin="0" aria-valuemax="100"><span></span></div></div>
        </div>
      </aside>
    </div>
  `;
}

function renderListPage(page, title, eyebrow, description, rows) {
  const body = rows.length ? `<div class="inline-list">${rows.map((row) => `
    <div class="inline-row"><div><strong>${escapeText(row.title)}</strong><small>${escapeText(row.meta)}</small></div><span class="${row.amount ? "amount" : "tag"}">${escapeText(row.value)}</span></div>
  `).join("")}</div>` : `<div class="empty-state"><strong>这里还没有内容</strong><span>先记录一件小事，之后再慢慢整理。</span></div>`;
  pageRoot.innerHTML = `<header class="page-heading"><div><span class="eyebrow">${escapeText(eyebrow)}</span><h1>${escapeText(title)}</h1></div><p class="heading-note">${escapeText(description)}</p></header><section class="surface list-page"><div class="surface-header"><h2>${escapeText(page === "review" ? "本周摘要" : "最近记录")}</h2><span class="tag">轻量视图</span></div><div class="surface-body">${body}</div></section>`;
}

function renderPage(page) {
  if (page === "today") return renderToday();
  if (page === "inbox") return renderListPage(page, "先放在这里。", "收件箱", "还没想好时间和分类的内容，可以先记录，不急着整理。", [
    { title: "买一双适合通勤的鞋", meta: "刚刚记录 · 未分类", value: "安排" },
    { title: "周末整理照片", meta: "昨天 · 兴趣", value: "安排" },
  ]);
  if (page === "goals") return renderListPage(page, "正在推进的事。", "目标", "目标不需要很多，重要的是它们能落到今天的一步。", [
    { title: "改善体能", meta: "健康 · 本周行动 2 / 3", value: "进行中" },
    { title: "完成 Livefil 第一阶段", meta: "工作 · 本周行动 4 / 6", value: "进行中" },
  ]);
  if (page === "expenses") return renderListPage(page, "看见钱的去向。", "开销", "记账不为了评判，而是为了知道哪些选择正在支持你的生活。", [
    { title: "晚饭", meta: "今天 · 餐饮 · 生活", value: "¥36.00", amount: true },
    { title: "地铁", meta: "今天 · 交通", value: "¥4.00", amount: true },
  ]);
  if (page === "review") return renderListPage(page, "这周发生了什么？", "复盘", "用几分钟看见计划和现实的差异，然后只做一个必要的调整。", [
    { title: "完成重要行动", meta: "计划 6 项 · 完成 4 项 · 部分完成 1 项", value: "查看" },
    { title: "本周开销", meta: "餐饮 ¥248 · 交通 ¥56 · 兴趣 ¥120", value: "¥424.00", amount: true },
  ]);
  return renderListPage(page, "按你的方式使用。", "设置", "时间、提醒、数据和 AI，都应该由你决定。", [
    { title: "账户与数据", meta: "云端账号 · 最近同步刚刚完成", value: "管理" },
    { title: "提醒与安静时段", meta: "工作日 09:00–21:30", value: "设置" },
  ]);
}

function setActivePage(page) {
  state.activePage = page;
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("is-active", button.dataset.page === page));
  renderPage(page);
  document.title = `Livefil · ${page === "today" ? "今日" : page}`;
}

function openModal(type = "task") {
  state.addType = type;
  document.querySelectorAll("[data-add-type]").forEach((button) => button.classList.toggle("is-active", button.dataset.addType === type));
  quickInput.value = "";
  quickInput.placeholder = type === "expense" ? "例如：晚饭 36 元，餐饮" : type === "note" ? "例如：下周想试试晨间散步" : "例如：晚饭后散步 20 分钟";
  quickHint.textContent = type === "expense" ? "金额是必需的，分类和目标之后可以补充。" : "先记下来，时间和分类之后再补充也可以。";
  modal.hidden = false;
  quickInput.focus();
}

function closeModal() { modal.hidden = true; }

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) setActivePage(pageButton.dataset.page);
  const taskButton = event.target.closest("[data-task-index]");
  if (taskButton) {
    const task = state.tasks[Number(taskButton.dataset.taskIndex)];
    task.status = task.status === "done" ? "planned" : "done";
    renderToday();
  }
  const addTypeButton = event.target.closest("[data-add-type]");
  if (addTypeButton) openModal(addTypeButton.dataset.addType);
  if (event.target.matches("[data-close-modal]")) closeModal();
});

document.querySelector("#open-add").addEventListener("click", () => openModal());
document.querySelector("#open-review").addEventListener("click", () => setActivePage("review"));
document.querySelector("#toggle-sidebar").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("is-open"));
document.querySelector("#quick-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = quickInput.value.trim();
  if (!value) return;
  if (state.addType === "task") state.tasks.push({ time: "待安排", title: value, meta: "收件箱 · 刚刚记录", status: "planned" });
  closeModal();
  setActivePage(state.addType === "task" ? "today" : state.addType === "expense" ? "expenses" : "inbox");
});

renderPage(state.activePage);
