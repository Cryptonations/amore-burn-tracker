// ===== Configuration =====
const CONFIG = {
    BURN_ADDRESS: 'UQAWJJLBJHWTRQtYovzGLNdSCgTReFx6QrOs0iejbmWtTVDh',
    TOKEN_CONTRACT: 'EQC7js8NLX3v57ZuRmuusNtMSBdki4va_qyL7sAwdmosf_xK',
    API_BASE: 'https://toncenter.com/api/v3',
    TONVIEWER: 'https://tonviewer.com',
    PAGE_SIZE: 128,
    TABLE_PAGE_SIZE: 50,
};

// ===== State =====
const state = {
    jettonInfo: null,       // { name, symbol, decimals, totalSupply }
    allTransfers: [],       // raw transfer objects from API
    filteredTransfers: [],  // after date filter
    addressBook: {},        // raw -> { user_friendly, name }
    tableOffset: 0,         // pagination offset for the visible table
    isLoading: false,
    autoRefreshId: null,    // setInterval id
    autoRefreshCountdown: 0,
    countdownId: null,
};

// ===== API Layer =====

async function fetchJSON(url, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(url);
        if (res.status === 429) {
            // Rate limited — wait and retry
            const wait = Math.min(1000 * Math.pow(2, attempt), 8000);
            console.warn(`Rate limited (429), retrying in ${wait}ms... (attempt ${attempt + 1})`);
            await sleep(wait);
            continue;
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
        return res.json();
    }
    throw new Error('API rate limit exceeded after retries');
}

async function loadJettonInfo() {
    try {
        const data = await fetchJSON(
            `${CONFIG.API_BASE}/jetton/masters?address=${CONFIG.TOKEN_CONTRACT}&limit=1`
        );
        const master = (data.jetton_masters || [])[0];
        if (!master) return null;

        // Metadata is in data.metadata[rawAddress].token_info[0]
        const rawAddr = master.address;
        const meta = data.metadata?.[rawAddr]?.token_info?.[0] || {};

        return {
            name: meta.name || 'Token',
            symbol: meta.symbol || '',
            decimals: parseInt(meta.extra?.decimals) || 9,
            description: meta.description || '',
            image: meta.image || null,
            totalSupply: master.total_supply || '0',
            rawAddress: rawAddr,
        };
    } catch (err) {
        console.error('loadJettonInfo error:', err);
        return { name: 'Token', symbol: '', decimals: 9, totalSupply: '0', rawAddress: '' };
    }
}

async function loadBurnBalance() {
    try {
        const data = await fetchJSON(
            `${CONFIG.API_BASE}/jetton/wallets?owner_address=${CONFIG.BURN_ADDRESS}&jetton_address=${CONFIG.TOKEN_CONTRACT}&limit=1`
        );
        const wallet = (data.jetton_wallets || [])[0];
        return wallet ? wallet.balance : '0';
    } catch (err) {
        console.error('loadBurnBalance error:', err);
        return null;
    }
}

async function loadTransferPage(offset) {
    const url = `${CONFIG.API_BASE}/jetton/transfers` +
        `?address=${CONFIG.BURN_ADDRESS}` +
        `&jetton_master=${CONFIG.TOKEN_CONTRACT}` +
        `&direction=in` +
        `&limit=${CONFIG.PAGE_SIZE}` +
        `&offset=${offset}` +
        `&sort=desc`;

    const data = await fetchJSON(url);

    // Merge address book
    if (data.address_book) {
        Object.assign(state.addressBook, data.address_book);
    }

    return data.jetton_transfers || [];
}

async function loadAllTransfers() {
    state.allTransfers = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        setLoadingText(`Загрузка транзакций... (${state.allTransfers.length})`);
        try {
            const transfers = await loadTransferPage(offset);
            if (transfers.length === 0) {
                hasMore = false;
            } else {
                state.allTransfers.push(...transfers);
                offset += transfers.length;
                if (transfers.length < CONFIG.PAGE_SIZE) {
                    hasMore = false;
                }
            }
        } catch (err) {
            console.error('loadAllTransfers error at offset', offset, err);
            hasMore = false;
        }

        // Delay to avoid rate limiting
        if (hasMore) await sleep(1500);
    }
}

// ===== Data Processing =====

function formatAmount(raw) {
    const decimals = state.jettonInfo?.decimals || 9;
    const value = Number(raw) / Math.pow(10, decimals);
    return value.toLocaleString('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function rawToNumber(raw) {
    const decimals = state.jettonInfo?.decimals || 9;
    return Number(raw) / Math.pow(10, decimals);
}

function friendlyAddr(raw) {
    if (!raw) return 'Unknown';
    const entry = state.addressBook[raw];
    if (entry?.user_friendly) return entry.user_friendly;
    return raw;
}

function shortAddr(addr) {
    if (!addr || addr.length < 12) return addr || 'Unknown';
    return addr.slice(0, 6) + '\u2026' + addr.slice(-4);
}

function addrName(raw) {
    const entry = state.addressBook[raw];
    return entry?.name || null;
}

function parseTransfer(t) {
    return {
        sender: t.source,
        senderFriendly: friendlyAddr(t.source),
        senderName: addrName(t.source),
        amount: t.amount,
        amountNum: rawToNumber(t.amount),
        amountFmt: formatAmount(t.amount),
        timestamp: t.transaction_now,
        date: new Date(t.transaction_now * 1000),
        txHash: t.transaction_hash,
        lt: t.transaction_lt,
    };
}

function computeStats(transfers) {
    const parsed = transfers.map(parseTransfer);
    const totalBurned = parsed.reduce((s, p) => s + p.amountNum, 0);
    const wallets = new Set(parsed.map(p => p.sender));
    const lastBurn = parsed.length > 0 ? parsed[0].date : null;

    // Top burners aggregation
    const map = {};
    for (const p of parsed) {
        if (!map[p.sender]) {
            map[p.sender] = {
                address: p.sender,
                friendly: p.senderFriendly,
                name: p.senderName,
                total: 0,
                txCount: 0,
            };
        }
        map[p.sender].total += p.amountNum;
        map[p.sender].txCount++;
    }
    const topBurners = Object.values(map).sort((a, b) => b.total - a.total);

    return {
        parsed,
        totalBurned,
        uniqueWallets: wallets.size,
        totalTx: parsed.length,
        lastBurn,
        topBurners,
    };
}

// ===== Rendering =====

function renderAddresses() {
    document.getElementById('burnAddr').textContent = CONFIG.BURN_ADDRESS;
    document.getElementById('tokenAddr').textContent = CONFIG.TOKEN_CONTRACT;
}

function renderStats() {
    const stats = computeStats(state.filteredTransfers);
    const symbol = state.jettonInfo?.symbol || '';

    document.getElementById('totalBurned').textContent =
        stats.totalBurned.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + (symbol ? ' ' + symbol : '');

    document.getElementById('uniqueWallets').textContent = stats.uniqueWallets.toLocaleString();
    document.getElementById('totalTx').textContent = stats.totalTx.toLocaleString();
    document.getElementById('lastBurn').textContent =
        stats.lastBurn ? stats.lastBurn.toLocaleDateString('ru-RU') : '\u2014';

    // Burn % of total supply
    const totalSupply = state.jettonInfo?.totalSupply;
    if (totalSupply && Number(totalSupply) > 0) {
        const supplyNum = rawToNumber(totalSupply);
        const pct = ((stats.totalBurned / supplyNum) * 100).toFixed(2);
        document.getElementById('burnPercent').textContent = `${pct}% от общего выпуска`;
    }
}

function renderTable() {
    const stats = computeStats(state.filteredTransfers);
    const tbody = document.getElementById('burnTableBody');
    const pageEnd = state.tableOffset + CONFIG.TABLE_PAGE_SIZE;
    const visible = stats.parsed.slice(0, pageEnd);

    if (visible.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Нет транзакций за выбранный период</td></tr>';
        document.getElementById('pagination').style.display = 'none';
        return;
    }

    tbody.innerHTML = visible.map((burn, i) => {
        const displayName = burn.senderName
            ? `<span style="color:var(--text-secondary);font-size:0.78rem">${burn.senderName}</span><br>`
            : '';
        return `<tr>
            <td>${i + 1}</td>
            <td class="addr-cell">
                ${displayName}<a class="addr-link" href="${CONFIG.TONVIEWER}/${burn.senderFriendly}" target="_blank" title="${burn.senderFriendly}">${shortAddr(burn.senderFriendly)}</a>
            </td>
            <td class="amount-cell">${burn.amountFmt} ${state.jettonInfo?.symbol || ''}</td>
            <td>${burn.date.toLocaleString('ru-RU')}</td>
            <td><a class="tx-link" href="${CONFIG.TONVIEWER}/transaction/${txHashToHex(burn.txHash)}" target="_blank">Открыть</a></td>
        </tr>`;
    }).join('');

    // Pagination
    const pagDiv = document.getElementById('pagination');
    if (pageEnd < stats.parsed.length) {
        pagDiv.style.display = 'flex';
        document.getElementById('paginationInfo').textContent =
            `Показано ${visible.length} из ${stats.parsed.length}`;
    } else {
        pagDiv.style.display = 'none';
    }
}

function renderTopBurners() {
    const stats = computeStats(state.filteredTransfers);
    const tbody = document.getElementById('topBurnersBody');
    const top = stats.topBurners.slice(0, 25);
    const symbol = state.jettonInfo?.symbol || '';

    if (top.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Нет данных</td></tr>';
        return;
    }

    tbody.innerHTML = top.map((b, i) => {
        const pct = stats.totalBurned > 0 ? ((b.total / stats.totalBurned) * 100).toFixed(1) : '0';
        const nameHtml = b.name
            ? `<span style="color:var(--text-secondary);font-size:0.78rem">${b.name}</span><br>`
            : '';
        return `<tr>
            <td>${i + 1}</td>
            <td class="addr-cell">
                ${nameHtml}<a class="addr-link" href="${CONFIG.TONVIEWER}/${b.friendly}" target="_blank" title="${b.friendly}">${shortAddr(b.friendly)}</a>
            </td>
            <td class="amount-cell">${b.total.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${symbol}</td>
            <td>${b.txCount}</td>
            <td>
                <div class="progress-wrap">
                    <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(parseFloat(pct), 100)}%"></div></div>
                    <span>${pct}%</span>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderAll() {
    renderStats();
    state.tableOffset = 0;
    renderTable();
    renderTopBurners();
}

// ===== Filtering =====

function applyFilters() {
    const fromVal = document.getElementById('dateFrom').value;
    const toVal = document.getElementById('dateTo').value;
    const walletQuery = document.getElementById('walletSearch').value.trim().toLowerCase();

    state.filteredTransfers = state.allTransfers.filter(t => {
        const d = new Date(t.transaction_now * 1000);
        if (fromVal) {
            const from = new Date(fromVal);
            from.setHours(0, 0, 0, 0);
            if (d < from) return false;
        }
        if (toVal) {
            const to = new Date(toVal);
            to.setHours(23, 59, 59, 999);
            if (d > to) return false;
        }
        if (walletQuery) {
            const friendly = friendlyAddr(t.source).toLowerCase();
            const raw = (t.source || '').toLowerCase();
            const name = (addrName(t.source) || '').toLowerCase();
            if (!friendly.includes(walletQuery) && !raw.includes(walletQuery) && !name.includes(walletQuery)) {
                return false;
            }
        }
        return true;
    });

    renderAll();
}

function resetFilter() {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    document.getElementById('walletSearch').value = '';
    state.filteredTransfers = [...state.allTransfers];
    renderAll();
}

// ===== Auto-refresh =====

function toggleAutoRefresh() {
    const btn = document.getElementById('autoRefreshToggle');
    const statusEl = document.getElementById('autoRefreshStatus');

    if (state.autoRefreshId) {
        // Stop
        clearInterval(state.autoRefreshId);
        clearInterval(state.countdownId);
        state.autoRefreshId = null;
        state.countdownId = null;
        btn.textContent = 'Включить';
        btn.classList.remove('btn-active');
        statusEl.textContent = '';
        return;
    }

    const seconds = parseInt(document.getElementById('autoRefreshInterval').value);
    if (!seconds) {
        showToast('Выберите интервал');
        return;
    }

    // Start
    btn.textContent = 'Выключить';
    btn.classList.add('btn-active');
    state.autoRefreshCountdown = seconds;

    function updateCountdown() {
        state.autoRefreshCountdown--;
        if (state.autoRefreshCountdown <= 0) {
            state.autoRefreshCountdown = seconds;
        }
        const m = Math.floor(state.autoRefreshCountdown / 60);
        const s = state.autoRefreshCountdown % 60;
        statusEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }

    updateCountdown();
    state.countdownId = setInterval(updateCountdown, 1000);

    state.autoRefreshId = setInterval(async () => {
        if (state.isLoading) return;
        state.autoRefreshCountdown = seconds;
        await loadData();
    }, seconds * 1000);
}

// ===== Export =====

function exportCSV() {
    const stats = computeStats(state.filteredTransfers);
    if (stats.parsed.length === 0) {
        showToast('Нет данных для экспорта');
        return;
    }

    const symbol = state.jettonInfo?.symbol || '';
    const header = '\uFEFF' + ['#', 'Wallet', 'Wallet (short)', 'Amount ' + symbol, 'Date (UTC)', 'Transaction Hash'].join(',') + '\n';
    const rows = stats.parsed.map((b, i) =>
        [
            i + 1,
            b.senderFriendly,
            shortAddr(b.senderFriendly),
            b.amountNum,
            b.date.toISOString(),
            b.txHash,
        ].join(',')
    ).join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `burn_tracker_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV скачан');
}

// ===== Utils =====

function base64ToHex(b64) {
    const raw = atob(b64);
    return Array.from(raw).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function txHashToHex(hash) {
    try {
        // toncenter returns standard base64, convert to hex for TonViewer URLs
        return base64ToHex(hash);
    } catch {
        return encodeURIComponent(hash);
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function showLoading(show) {
    document.getElementById('loading').classList.toggle('hidden', !show);
    state.isLoading = show;
}

function setLoadingText(text) {
    document.getElementById('loadingText').textContent = text;
}

function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'toast success';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
}

// Global helper for copy buttons in HTML
function copyText(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Скопировано'));
}

// ===== Raffle =====

const RAFFLE_COLORS = ['#c084fc','#a855f7','#e879f9','#f0abfc','#7c3aed','#ff6b35','#fbbf24'];

function openRaffle() {
    const stats = computeStats(state.filteredTransfers);
    const uniqueWallets = [...new Set(stats.parsed.map(p => p.senderFriendly))];

    const modal = document.getElementById('raffleModal');
    const poolInfo = document.getElementById('rafflePoolInfo');
    const winner = document.getElementById('raffleWinner');
    const drumItem = document.getElementById('raffleDrumItem');

    winner.classList.add('hidden');
    drumItem.textContent = uniqueWallets.length > 0 ? '?' : '—';
    poolInfo.textContent = uniqueWallets.length > 0
        ? `${uniqueWallets.length} уникальных кошельков в пуле`
        : 'Нет данных — выберите период';
    document.getElementById('raffleSubtitle').textContent = 'Выбери победителя из текущего фильтра';
    document.getElementById('raffleParticles').innerHTML = '';
    document.getElementById('raffleSpinBtn').disabled = uniqueWallets.length === 0;

    modal.classList.remove('hidden');
}

function closeRaffle() {
    document.getElementById('raffleModal').classList.add('hidden');
}

function spawnParticles() {
    const container = document.getElementById('raffleParticles');
    container.innerHTML = '';
    const cx = container.offsetWidth / 2;
    const cy = container.offsetHeight / 2;
    for (let i = 0; i < 30; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const angle = Math.random() * 2 * Math.PI;
        const dist = 80 + Math.random() * 160;
        p.style.cssText = `
            left:${cx}px; top:${cy}px;
            background:${RAFFLE_COLORS[Math.floor(Math.random() * RAFFLE_COLORS.length)]};
            --tx:${Math.cos(angle) * dist}px;
            --ty:${Math.sin(angle) * dist}px;
            animation-delay:${Math.random() * 0.2}s;
            width:${4 + Math.random() * 8}px;
            height:${4 + Math.random() * 8}px;
        `;
        container.appendChild(p);
    }
}

function runRaffle() {
    const stats = computeStats(state.filteredTransfers);
    const uniqueWallets = [...new Set(stats.parsed.map(p => p.senderFriendly))];
    if (uniqueWallets.length === 0) return;

    const spinBtn = document.getElementById('raffleSpinBtn');
    const drumWrap = document.getElementById('raffleDrum').parentElement;
    const drumItem = document.getElementById('raffleDrumItem');
    const winnerEl = document.getElementById('raffleWinner');

    spinBtn.disabled = true;
    winnerEl.classList.add('hidden');
    drumWrap.classList.add('spinning');
    document.getElementById('raffleSubtitle').textContent = 'Крутим барабан...';

    // Pick winner upfront, animate for drama
    const winnerAddr = uniqueWallets[Math.floor(Math.random() * uniqueWallets.length)];
    const totalSpins = 30 + Math.floor(Math.random() * 20);
    let spin = 0;

    function tick() {
        // Show random wallets
        const r = uniqueWallets[Math.floor(Math.random() * uniqueWallets.length)];
        drumItem.textContent = shortAddr(r);

        spin++;
        // Gradually slow down
        const delay = spin < totalSpins * 0.6
            ? 50
            : spin < totalSpins * 0.85
                ? 100
                : 180;

        if (spin < totalSpins) {
            setTimeout(tick, delay);
        } else {
            // Reveal winner
            drumWrap.classList.remove('spinning');
            drumItem.textContent = shortAddr(winnerAddr);
            document.getElementById('raffleSubtitle').textContent = '🎉 Победитель определён!';

            // Compute winner stats
            const winnerTx = stats.parsed.filter(p => p.senderFriendly === winnerAddr);
            const winnerTotal = winnerTx.reduce((s, p) => s + p.amountNum, 0);
            const symbol = state.jettonInfo?.symbol || '';

            document.getElementById('raffleWinnerAddr').textContent = winnerAddr;
            document.getElementById('raffleWinnerAddr').href = `${CONFIG.TONVIEWER}/${winnerAddr}`;
            document.getElementById('raffleWinnerStats').textContent =
                `${winnerTx.length} транзакций · ${winnerTotal.toLocaleString('ru-RU', {maximumFractionDigits: 2})} ${symbol}`;
            document.getElementById('raffleCopyBtn').onclick = () =>
                navigator.clipboard.writeText(winnerAddr).then(() => showToast('Адрес скопирован!'));

            winnerEl.classList.remove('hidden');
            spawnParticles();
            spinBtn.disabled = false;
            spinBtn.textContent = 'Ещё раз!';
        }
    }

    tick();
}

// ===== Event Listeners =====

function setupListeners() {
    document.getElementById('applyFilter').addEventListener('click', applyFilters);
    document.getElementById('resetFilter').addEventListener('click', resetFilter);
    document.getElementById('exportCsv').addEventListener('click', exportCSV);
    document.getElementById('autoRefreshToggle').addEventListener('click', toggleAutoRefresh);

    document.getElementById('loadMoreBtn').addEventListener('click', () => {
        state.tableOffset += CONFIG.TABLE_PAGE_SIZE;
        renderTable();
    });

    document.getElementById('refreshBtn').addEventListener('click', async () => {
        if (state.isLoading) return;
        await loadData();
    });

    // Enter key in search field triggers filter
    document.getElementById('walletSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') applyFilters();
    });

    // Raffle
    document.getElementById('raffleBtn').addEventListener('click', openRaffle);
    document.getElementById('raffleClose').addEventListener('click', closeRaffle);
    document.getElementById('raffleSpinBtn').addEventListener('click', runRaffle);
    document.getElementById('raffleModal').addEventListener('click', e => {
        if (e.target.classList.contains('raffle-backdrop')) closeRaffle();
    });
}

// ===== Main =====

async function loadData() {
    showLoading(true);

    try {
        setLoadingText('Загрузка информации о токене...');
        state.jettonInfo = await loadJettonInfo();

        // Update title
        if (state.jettonInfo?.name) {
            document.getElementById('appTitle').textContent = `${state.jettonInfo.name} Burn Tracker`;
            document.title = `${state.jettonInfo.name} Burn Tracker`;
        }

        setLoadingText('Загрузка баланса сжигания...');
        await sleep(500);
        const balance = await loadBurnBalance();

        // Load transfers
        await sleep(500);
        await loadAllTransfers();

        // Re-apply current filters after reload
        applyFilters();

        // Show balance-based total if no transfers loaded
        if (balance && state.allTransfers.length === 0) {
            document.getElementById('totalBurned').textContent =
                formatAmount(balance) + ' ' + (state.jettonInfo?.symbol || '');
        }

        showToast(`Данные обновлены: ${state.allTransfers.length} транзакций`);
    } catch (err) {
        console.error('loadData error:', err);
        showToast('Ошибка загрузки данных. Попробуйте обновить.');
    }

    showLoading(false);
}

async function init() {
    renderAddresses();
    setupListeners();
    await loadData();
}

document.addEventListener('DOMContentLoaded', init);
