let extractedData = null;
let currentTabMode = 'md'; // 'md' | 'json'

const statusBar = document.getElementById('statusBar');
const previewArea = document.getElementById('previewArea');
const chkIncludePrompt = document.getElementById('chkIncludePrompt');
const btnCopyMd = document.getElementById('btnCopyMd');
const btnCopyJson = document.getElementById('btnCopyJson');
const btnRescan = document.getElementById('btnRescan');
const tabMd = document.getElementById('tabMd');
const tabJson = document.getElementById('tabJson');
const toast = document.getElementById('toast');

// Hàm chạy trực tiếp trong context của trang Google Ads
function scrapeGoogleAdsPage() {
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function querySelectorAllDeep(selector, root = document) {
    const results = Array.from(root.querySelectorAll(selector));
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        results.push(...querySelectorAllDeep(selector, el.shadowRoot));
      }
    }
    return results;
  }

  // Lấy text sạch của phần tử ĐANG HIỂN THỊ (bỏ qua popup ẩn, lịch ẩn, icon tên chữ)
  function getCleanVisibleText(rootEl) {
    if (!rootEl || !isVisible(rootEl)) return '';
    const junkTags = new Set(['SCRIPT', 'STYLE', 'MAT-ICON', 'MATERIAL-ICON', 'SVG', 'NOSCRIPT']);
    const junkClasses = [
      'material-icons',
      'google-material-icons',
      'ess-cell-tooltip',
      'particle-table-header-Menu'
    ];

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue || '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node;
      if (junkTags.has(el.tagName)) return '';
      if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'tooltip') {
        return '';
      }
      if (junkClasses.some(cls => el.classList && el.classList.contains(cls))) {
        return '';
      }
      if (!isVisible(el)) return '';

      let text = '';
      const children = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
      for (const child of children) {
        text += ' ' + walk(child);
      }
      return text;
    }

    return walk(rootEl).replace(/\s+/g, ' ').trim();
  }

  const pageTitle = document.title || '';
  const url = window.location.origin + window.location.pathname;

  // 1. Lấy khoảng thời gian đang chọn (chỉ lấy nút hiển thị, không lấy popup lịch ẩn)
  const dateBtnEls = querySelectorAllDeep(
    '[aria-label*="Date range"], [aria-label*="Phạm vi ngày"], .date-picker-button, material-datepicker .button, [class*="datepicker"] [role="button"]'
  ).filter(isVisible);
  let dateRange = '';
  for (const el of dateBtnEls) {
    const t = getCleanVisibleText(el);
    if (t && t.length < 80 && !t.includes('JanFebMar')) {
      dateRange = t;
      break;
    }
  }

  // 2. Lấy dữ liệu bôi đen (nếu có)
  const selectedText = window.getSelection ? window.getSelection().toString().trim() : '';

  // 3. Lấy các thẻ KPI / Scorecards & Overview Cards
  const scorecards = [];
  const cardCandidates = querySelectorAllDeep(
    'scorecard, .scorecard, [class*="scorecard"], overview-card, [class*="overview-card"], [class*="summary-card"], mat-card, ess-card'
  ).filter(isVisible);

  const rootCards = cardCandidates.filter(
    c => !cardCandidates.some(other => other !== c && other.contains(c))
  );

  rootCards.forEach(card => {
    const text = getCleanVisibleText(card);
    if (text && text.length > 3 && text.length < 1500) {
      scorecards.push(text);
    }
  });

  // 4. Quét các bảng dữ liệu đang hiển thị (bỏ qua bảng lịch datepicker)
  const tableCandidates = querySelectorAllDeep(
    'ess-table, [role="grid"], [role="table"], table'
  ).filter(el => {
    if (!isVisible(el)) return false;
    // Bỏ qua bảng lịch chọn ngày tháng
    if (el.closest('material-datepicker, [class*="datepicker"], [class*="calendar"]')) {
      return false;
    }
    return true;
  });

  const rootTables = tableCandidates.filter(
    t => !tableCandidates.some(other => other !== t && other.contains(t))
  );

  const tables = [];

  rootTables.forEach((tableEl, idx) => {
    const rowEls = Array.from(tableEl.querySelectorAll('[role="row"], tr')).filter(isVisible);
    if (rowEls.length < 2) return;

    let headers = [];
    const rows = [];

    rowEls.forEach(rowEl => {
      const headerCells = Array.from(
        rowEl.querySelectorAll('[role="columnheader"], th')
      ).filter(isVisible);

      if (headerCells.length > 0) {
        const extractedHeaders = headerCells.map(c => getCleanVisibleText(c));
        if (extractedHeaders.filter(Boolean).length >= headers.filter(Boolean).length) {
          headers = extractedHeaders;
        }
        return;
      }

      const dataCells = Array.from(
        rowEl.querySelectorAll('[role="gridcell"], [role="rowheader"], [role="cell"], td, ess-cell')
      ).filter(isVisible);

      const leafCells = dataCells.filter(
        c => !dataCells.some(other => other !== c && c.contains(other))
      );

      if (leafCells.length > 0) {
        const rowValues = leafCells.map(c => getCleanVisibleText(c));
        // Bỏ qua dòng lịch Jan Feb Mar Apr nếu còn sót
        const joined = rowValues.join(' ');
        if (/^(Jan Feb Mar|May Jun Jul|Sep Oct Nov)/.test(joined)) return;
        if (rowValues.some(val => val !== '')) {
          rows.push(rowValues);
        }
      }
    });

    if (rows.length === 0) return;

    const maxCols = Math.max(headers.length, ...rows.map(r => r.length));
    const validColIndices = [];
    for (let col = 0; col < maxCols; col++) {
      const hasHeader = headers[col] && headers[col].trim() !== '';
      const hasData = rows.some(r => r[col] && r[col].trim() !== '');
      if (hasHeader || hasData) {
        validColIndices.push(col);
      }
    }

    const cleanHeaders = validColIndices.map((col, i) => headers[col] || `Cột ${i + 1}`);
    const cleanRows = rows.map(r => validColIndices.map(col => r[col] || ''));

    tables.push({
      tableIndex: idx + 1,
      headers: cleanHeaders,
      rowCount: cleanRows.length,
      rows: cleanRows
    });
  });

  // 5. Luôn lấy thêm nội dung hiển thị của vùng chính (Main Content) để không sót số liệu ở trang Overview
  const mainEl =
    document.querySelector('[role="main"], main, .awsm-child-content, #cm-extension-view') ||
    document.body;
  const rawLines = (mainEl.innerText || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      // Lọc bỏ các tên icon của Google Material
      if (/^(arrow_upward|arrow_downward|help_outline|more_vert|check_circle|warning|info|expand_more|expand_less|chevron_right|chevron_left|close|search|filter_list|download|edit|add)$/.test(l)) {
        return false;
      }
      return true;
    });

  const mainVisibleSnapshot = rawLines.slice(0, 400).join('\n');

  return {
    extractedAt: new Date().toISOString(),
    pageTitle,
    url,
    dateRange,
    scorecards: [...new Set(scorecards)],
    selectedText,
    tables,
    mainVisibleSnapshot
  };
}

function buildMarkdown(data, includePrompt) {
  if (!data) return '';
  const lines = [];

  if (includePrompt) {
    lines.push('Hãy đóng vai chuyên gia tối ưu Google Ads. Phân tích dữ liệu chiến dịch/từ khóa dưới đây cho tôi:');
    lines.push('1. Đánh giá hiệu quả tổng quan (Chi phí, CTR, CPC, Chuyển đổi / CPA).');
    lines.push('2. Chỉ ra những chiến dịch / nhóm quảng cáo / từ khóa đang đốt tiền hoặc kém hiệu quả cần tắt/tối ưu.');
    lines.push('3. Đề xuất hành động cụ thể để tăng tỷ lệ chuyển đổi và giảm CPC.');
    lines.push('\n---\n');
  }

  lines.push(`# Dữ liệu Google Ads: ${data.pageTitle || 'Trang quản trị'}`);
  lines.push(`- **URL**: ${data.url}`);
  if (data.dateRange) {
    lines.push(`- **Khoảng thời gian**: ${data.dateRange}`);
  }
  lines.push(`- **Thời điểm trích xuất**: ${new Date(data.extractedAt).toLocaleString('vi-VN')}`);
  lines.push('');

  if (data.scorecards && data.scorecards.length > 0) {
    lines.push('## Thẻ chỉ số & Tổng quan (Cards)');
    data.scorecards.forEach(sc => {
      lines.push(`- ${sc}`);
    });
    lines.push('');
  }

  if (data.tables && data.tables.length > 0) {
    data.tables.forEach((tbl, idx) => {
      lines.push(`## Bảng dữ liệu ${idx + 1} (${tbl.rowCount} dòng)`);
      lines.push('');
      const escapeMd = str => String(str || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push('| ' + tbl.headers.map(escapeMd).join(' | ') + ' |');
      lines.push('| ' + tbl.headers.map(() => '---').join(' | ') + ' |');
      tbl.rows.forEach(row => {
        lines.push('| ' + row.map(escapeMd).join(' | ') + ' |');
      });
      lines.push('');
    });
  }

  if (data.selectedText) {
    lines.push('## Nội dung đang bôi đen');
    lines.push('```text');
    lines.push(data.selectedText);
    lines.push('```');
    lines.push('');
  }

  // Nếu ở trang Overview hoặc bảng có ít dòng, đính kèm thêm Snapshot văn bản trên màn hình
  const totalTableRows = (data.tables || []).reduce((s, t) => s + t.rowCount, 0);
  if (data.mainVisibleSnapshot && (totalTableRows < 5 || data.url.includes('/overview'))) {
    lines.push('## Toàn bộ số liệu hiển thị trên màn hình (Snapshot)');
    lines.push('```text');
    lines.push(data.mainVisibleSnapshot);
    lines.push('```');
  }

  return lines.join('\n');
}

function buildJson(data, includePrompt) {
  if (!data) return '';
  const payload = includePrompt
    ? {
        aiInstruction:
          'Hãy phân tích dữ liệu Google Ads này: 1) Đánh giá tổng quan Chi phí, CTR, CPC, Chuyển đổi. 2) Chỉ ra hạng mục đốt tiền/kém hiệu quả. 3) Đề xuất tối ưu cụ thể.',
        ...data
      }
    : data;
  return JSON.stringify(payload, null, 2);
}

function updatePreview() {
  if (!extractedData) return;
  const includePrompt = chkIncludePrompt.checked;
  if (currentTabMode === 'md') {
    previewArea.value = buildMarkdown(extractedData, includePrompt);
  } else {
    previewArea.value = buildJson(extractedData, includePrompt);
  }
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2000);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`✅ Đã copy ${label}! Paste cho AI ngay.`);
  } catch (err) {
    previewArea.select();
    document.execCommand('copy');
    showToast(`✅ Đã copy ${label}!`);
  }
}

async function scanCurrentTab() {
  statusBar.className = 'status';
  statusBar.textContent = '⏳ Đang quét dữ liệu trên tab hiện tại...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('Không tìm thấy tab đang mở.');
    }

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://'))) {
      statusBar.className = 'status warn';
      statusBar.textContent = '⚠️ Hãy chuyển sang tab Google Ads (ads.google.com) rồi bấm vào tiện ích.';
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeGoogleAdsPage
    });

    if (!results || !results[0] || !results[0].result) {
      throw new Error('Không đọc được cấu trúc trang.');
    }

    extractedData = results[0].result;
    const tableCount = extractedData.tables ? extractedData.tables.length : 0;
    const totalRows = extractedData.tables
      ? extractedData.tables.reduce((sum, t) => sum + t.rowCount, 0)
      : 0;

    statusBar.className = 'status';
    statusBar.textContent = `✅ Đã quét: ${tableCount} bảng (${totalRows} dòng) + toàn bộ số liệu màn hình`;

    updatePreview();
  } catch (err) {
    statusBar.className = 'status error';
    statusBar.textContent = '❌ Lỗi: ' + (err.message || 'Không thể quét trang này.');
  }
}

chkIncludePrompt.addEventListener('change', updatePreview);

tabMd.addEventListener('click', () => {
  currentTabMode = 'md';
  tabMd.classList.add('active');
  tabJson.classList.remove('active');
  updatePreview();
});

tabJson.addEventListener('click', () => {
  currentTabMode = 'json';
  tabJson.classList.add('active');
  tabMd.classList.remove('active');
  updatePreview();
});

btnCopyMd.addEventListener('click', () => {
  if (!extractedData) return;
  currentTabMode = 'md';
  tabMd.classList.add('active');
  tabJson.classList.remove('active');
  const md = buildMarkdown(extractedData, chkIncludePrompt.checked);
  previewArea.value = md;
  copyText(md, 'Markdown');
});

btnCopyJson.addEventListener('click', () => {
  if (!extractedData) return;
  currentTabMode = 'json';
  tabJson.classList.add('active');
  tabMd.classList.remove('active');
  const json = buildJson(extractedData, chkIncludePrompt.checked);
  previewArea.value = json;
  copyText(json, 'JSON');
});

btnRescan.addEventListener('click', scanCurrentTab);

document.addEventListener('DOMContentLoaded', scanCurrentTab);
