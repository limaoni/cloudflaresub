function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const apiTokenInput = document.getElementById('apiToken');

if (localStorage.getItem('cf_sub_token')) {
  apiTokenInput.value = localStorage.getItem('cf_sub_token');
}

function getApiUrl(path, extraParams = '') {
  const token = apiTokenInput?.value.trim() || '';
  if (token) localStorage.setItem('cf_sub_token', token);
  else localStorage.removeItem('cf_sub_token');
  
  let qs = token ? `token=${encodeURIComponent(token)}` : '';
  if (extraParams) {
    qs += qs ? `&${extraParams}` : extraParams;
  }
  return path + (qs ? `?${qs}` : '');
}

async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
  } else {
    const text = await res.text();
    throw new Error(`服务异常 (${res.status})：${text.slice(0, 100)}`);
  }
}

const form = document.getElementById('generator-form');
const submitBtn = document.getElementById('submitBtn');
const fillDemoBtn = document.getElementById('fillDemoBtn');
const resultSection = document.getElementById('resultSection');
const warningBox = document.getElementById('warningBox');
const previewBody = document.getElementById('previewBody');

const autoUrl = document.getElementById('autoUrl');
const rawUrl = document.getElementById('rawUrl');
const clashUrl = document.getElementById('clashUrl');
const surgeUrl = document.getElementById('surgeUrl');
const emptyState = document.getElementById('emptyState');

const historyContainer = document.getElementById('historyContainer');
const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');

const qrModal = document.getElementById('qrModal');
const qrCanvas = document.getElementById('qrCanvas');
const qrText = document.getElementById('qrText');
const closeQrModal = document.getElementById('closeQrModal');

let globalHistoryList = [];

const demoVmess = [
  'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vLXdzLXRscyIsCiAgImFkZCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAicG9ydCI6ICI0NDMiLAogICJpZCI6ICIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLAogICJzY3kiOiAiYXV0byIsCiAgIm5ldCI6ICJ3cyIsCiAgInRscyI6ICJ0bHMiLAogICJwYXRoIjogIi93cyIsCiAgImhvc3QiOiAiZWRnZS5leGFtcGxlLmNvbSIsCiAgInNuaSI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAiZnAiOiAiY2hyb21lIiwKICAiYWxwbiI6ICJoMixodHRwLzEuMSIKfQ=='
].join('\n');

const demoIps = [
  '104.16.1.2#HK-01',
  '104.17.2.3#HK-02',
  '104.18.3.4:2053#US-Edge'
].join('\n');

fillDemoBtn.addEventListener('click', () => {
  document.getElementById('nodeLinks').value = demoVmess;
  document.getElementById('preferredIps').value = demoIps;
  document.getElementById('namePrefix').value = 'CF';
  document.getElementById('keepOriginalHost').checked = true;
});

async function loadHistory() {
  try {
    const data = await safeFetchJson(getApiUrl('/api/history'));
    globalHistoryList = data.list || [];
    renderHistoryView(globalHistoryList);
  } catch (err) {
    if (err.message.includes('Token')) {
      historyContainer.innerHTML = '<div class="empty-state">🔒 请在上方填入「访问凭证 Token」后点击「刷新记录」</div>';
    } else {
      historyContainer.innerHTML = `<div class="empty-state">加载历史记录失败：${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderHistoryView(list) {
  if (!list.length) {
    historyContainer.innerHTML = '<div class="empty-state">暂无历史记录</div>';
    return;
  }

  const html = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>生成时间</th>
            <th>前缀备注</th>
            <th>节点概况</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((item) => {
            const timeStr = new Date(item.createdAt).toLocaleString();
            const prefix = item.namePrefix ? escapeHtml(item.namePrefix) : '<span style="color:var(--muted)">无</span>';
            const nodeInfo = `${item.counts.inputNodes} 原节点 × ${item.counts.preferredEndpoints} 优选 → ${item.counts.outputNodes} 节点`;
            return `
              <tr>
                <td>${timeStr}</td>
                <td><strong>${prefix}</strong></td>
                <td>${nodeInfo}</td>
                <td>
                  <div class="history-btn-group">
                    <button type="button" class="secondary small history-action-btn" onclick="window.restoreHistory('${item.id}', this)">载入</button>
                    <button type="button" class="secondary small history-action-btn" onclick="window.copyText('${item.urls.clash}')">复制 Clash</button>
                    <button type="button" class="secondary small history-action-btn" onclick="window.copyText('${item.urls.auto}')">复制通用</button>
                    <button type="button" class="danger small history-action-btn" onclick="window.deleteHistory('${item.id}')">删除</button>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  historyContainer.innerHTML = html;
}

window.restoreHistory = async function(id, btnElement) {
  try {
    const originalText = btnElement ? btnElement.textContent : '载入';
    if (btnElement) {
      btnElement.textContent = '读取中...';
      btnElement.disabled = true;
    }

    const data = await safeFetchJson(getApiUrl('/api/detail', `id=${encodeURIComponent(id)}`));
    if (!data.inputMeta) throw new Error('数据结构异常，无法恢复');

    document.getElementById('nodeLinks').value = data.inputMeta.nodeLinks || '';
    document.getElementById('preferredIps').value = data.inputMeta.preferredIps || '';
    document.getElementById('namePrefix').value = data.inputMeta.namePrefix || '';
    document.getElementById('keepOriginalHost').checked = data.inputMeta.keepOriginalHost !== false;

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    if (btnElement) {
      btnElement.textContent = originalText;
      btnElement.disabled = false;
    }
  } catch (err) {
    alert(err.message);
    if (btnElement) {
      btnElement.textContent = '载入失败';
      btnElement.disabled = false;
    }
  }
};

window.deleteHistory = async function(id) {
  if (!confirm('确定要删除这条历史生成记录吗？')) return;
  try {
    await safeFetchJson(getApiUrl('/api/history', `id=${encodeURIComponent(id)}`), { method: 'DELETE' });
    loadHistory();
  } catch (err) {
    alert(err.message);
  }
};

window.copyText = async function(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert('订阅链接已复制到剪贴板！');
  } catch {
    prompt('请手动复制订阅链接：', text);
  }
};

refreshHistoryBtn.addEventListener('click', loadHistory);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  warningBox.classList.add('hidden');
  previewBody.innerHTML = '';

  const payload = {
    nodeLinks: document.getElementById('nodeLinks').value,
    preferredIps: document.getElementById('preferredIps').value,
    namePrefix: document.getElementById('namePrefix').value,
    keepOriginalHost: document.getElementById('keepOriginalHost').checked,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = '生成中...';

  try {
    const data = await safeFetchJson(getApiUrl('/api/generate'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    autoUrl.value = data.urls.auto;
    rawUrl.value = data.urls.raw;
    document.getElementById('rocketUrl').value = data.urls.raw;
    clashUrl.value = data.urls.clash;
    surgeUrl.value = data.urls.surge;

    emptyState.classList.add('hidden');

    document.getElementById('statInputNodes').textContent = data.counts.inputNodes;
    document.getElementById('statEndpoints').textContent = data.counts.preferredEndpoints;
    document.getElementById('statOutputNodes').textContent = data.counts.outputNodes;

    previewBody.innerHTML = data.preview
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.type)}</td>
            <td>${escapeHtml(item.server)}</td>
            <td>${escapeHtml(String(item.port))}</td>
            <td>${escapeHtml(item.host || '-')}</td>
            <td>${escapeHtml(item.sni || '-')}</td>
          </tr>`,
      )
      .join('');

    if (Array.isArray(data.warnings) && data.warnings.length) {
      warningBox.textContent = data.warnings.join('\n');
      warningBox.classList.remove('hidden');
    }

    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadHistory();
  } catch (error) {
    warningBox.textContent = error.message || '请求失败';
    warningBox.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '生成订阅';
  }
});

document.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy-target]');
  if (copyButton) {
    const input = document.getElementById(copyButton.dataset.copyTarget);
    if (!input?.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      const originalText = copyButton.textContent;
      copyButton.textContent = '已复制';
      setTimeout(() => {
        copyButton.textContent = originalText;
      }, 1200);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    return;
  }

  const qrButton = event.target.closest('[data-qrcode-target]');
  if (qrButton) {
    warningBox.classList.add('hidden');
    const input = document.getElementById(qrButton.dataset.qrcodeTarget);
    if (!input?.value) {
      warningBox.textContent = '请先生成订阅链接，再显示二维码。';
      warningBox.classList.remove('hidden');
      return;
    }

    if (!window.QRCode) {
      warningBox.textContent = '二维码组件加载失败，请刷新页面后重试。';
      warningBox.classList.remove('hidden');
      return;
    }

    qrCanvas.innerHTML = '';
    qrText.textContent = input.value;
    qrModal.classList.remove('hidden');
    qrModal.setAttribute('aria-hidden', 'false');

    new window.QRCode(qrCanvas, {
      text: input.value,
      width: 220,
      height: 220,
      correctLevel: window.QRCode.CorrectLevel.M,
    });
    return;
  }

  if (event.target.closest('[data-close-modal="true"]')) {
    closeQrDialog();
  }
});

closeQrModal.addEventListener('click', closeQrDialog);

function closeQrDialog() {
  qrModal.classList.add('hidden');
  qrModal.setAttribute('aria-hidden', 'true');
  qrCanvas.innerHTML = '';
}

loadHistory();
