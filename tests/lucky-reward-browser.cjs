// Run against a local production build. All business APIs are mocked;
// this test never creates orders, claims, or messages in the real database.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tableId = '11111111-1111-4111-8111-111111111111';
const spinId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const now = new Date();
const day = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const base = process.env.WHEEL_TEST_URL || 'http://localhost:3109';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Local server required');

(async () => {
  const ios = process.env.WHEEL_DEVICE === 'ios';
  const browser = await (ios ? webkit.launch({ headless: true }) : chromium.launch({ channel: 'msedge', headless: true }));
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 640 }, isMobile: true,
      userAgent: ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Zalo'
        : 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36 Zalo',
      deviceScaleFactor: 1, timezoneId: 'Asia/Ho_Chi_Minh', serviceWorkers: 'block' });
    const page = await context.newPage();
    const capture = async name => {
      if (!process.env.WHEEL_DEMO_DIR) return;
      fs.mkdirSync(process.env.WHEEL_DEMO_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WHEEL_DEMO_DIR, `${name}.png`), fullPage: true, animations: 'disabled' });
    };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let spin = { id: spinId, status: 'waiting_follow', prize_type: 'gift_drink', prize_value: 1,
      prize_label: 'Tặng nước', prize_key: 'gift', created_at: now.toISOString(), discount_amount: 0 };
    let failGift = true;
    let giftRequests = 0;
    const menu = { id: itemId, name: 'Nước thử nghiệm', price: 15000, is_available: true, options: [], category_id: null };
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const mockHeaders = { 'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': route.request().headers()['access-control-request-headers'] || '*' };
      const json = data => route.fulfill({ contentType: 'application/json', headers: mockHeaders, body: JSON.stringify(data) });
      if (url.pathname.includes('/rest/v1/') && route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: mockHeaders });
      if (url.origin === base && url.pathname === '/mock-zalo') return route.fulfill({ contentType: 'text/html', body: '<p>External Zalo page simulation</p>' });
      if (url.pathname === '/api/lucky/spin') return json({ ok: true, spinId, prizeKey: 'gift',
        prizeType: 'gift_drink', prizeValue: 1, prizeLabel: 'Tặng 1 nước tuỳ chọn', needFollow: true });
      if (url.pathname === '/api/lucky/claim-ready') return json({ ok: true, matched: false });
      if (url.pathname === '/api/lucky/pick-gift') {
        giftRequests++;
        if (failGift) return json({ ok: false, message: 'Quà chưa được ghi vào hoá đơn. Quý khách thử lại nhé!' });
        spin = { ...spin, applied_item_id: 'gift-line', gift_menu_item_id: itemId };
        return json({ ok: true, applied: true });
      }
      if (url.pathname.startsWith('/api/')) return json([]);
      if (url.pathname.includes('/rest/v1/')) {
        const name = url.pathname.split('/').pop();
        const single = route.request().headers().accept?.includes('vnd.pgrst.object');
        let data = [];
        if (name === 'get_my_lucky_spin') data = [spin];
        else if (name === 'tables') data = [{ id: tableId, table_number: 1, status: 'occupied', table_type: 'normal',
          occupied_at: new Date(now.getTime() - 600000).toISOString(), merged_with: null }];
        else if (name === 'menu_items') data = [menu];
        else if (name === 'orders') data = [{ id: 'order-test', table_id: tableId, customer_phone: '0900000000',
          customer_name: 'Khách thử', total_amount: 200000, status: 'pending', created_at: now.toISOString(), order_items: [] }];
        else if (name === 'settings') data = [
          { key: 'lucky_wheel_enabled', value: 'true' }, { key: 'lucky_wheel_require_follow', value: 'true' },
          { key: 'lucky_wheel_drink_item_ids', value: JSON.stringify([itemId]) },
          { key: 'zalo_follow_url', value: 'https://zalo.me/1234567890' },
        ];
        else if (name === 'lucky_prizes') data = [{ id: 'gift', label: 'Tặng nước', short: 'Nước', type: 'gift_drink', value: 1, weight: 1, color: '#fb923c' }];
        if (name === 'settings' && url.searchParams.get('key') === 'eq.lucky_wheel_drink_item_ids') {
          data = data.filter(row => row.key === 'lucky_wheel_drink_item_ids');
        }
        return json(single ? data[0] ?? null : data);
      }
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    await page.addInitScript(({ tableId, spinId, day, demo }) => {
      // Seed once so reload can verify persistence and dismissal correctly.
      if (localStorage.getItem('wheel_test_seeded')) return;
      localStorage.setItem('wheel_test_seeded', '1');
      if (!demo) {
        localStorage.setItem(`lucky_spin_${tableId}`, spinId);
        localStorage.setItem(`lucky_spin_${tableId}_pending`, spinId);
      }
      localStorage.setItem('order_session', JSON.stringify({ tableId, date: day,
        lastActive: Date.now(), customerName: 'Khách thử', customerPhone: '0900000000', orderId: 'order-test', cart: [] }));
    }, { tableId, spinId, day, demo: !!process.env.WHEEL_DEMO_DIR });
    await page.goto(`${base}/order?table=${tableId}`);
    const panel = page.locator('.co-chal-modal').filter({ hasText: 'Vòng xoay may mắn' });
    if (process.env.WHEEL_DEMO_DIR) {
      await page.locator('.co-promo-pill.wheel').click();
      await capture('01-before-spin');
      await panel.getByRole('button', { name: 'QUAY NGAY! 🎁', exact: true }).click();
    }
    await panel.waitFor({ state: 'visible' });
    await panel.getByText('Mở Zalo, bấm Quan tâm!', { exact: false }).waitFor();
    await page.waitForTimeout(350); // let the modal entrance animation finish
    const zaloLink = panel.getByRole('link', { name: 'Mở Zalo, bấm Quan tâm!', exact: true });
    const box = await zaloLink.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 640, 'Zalo CTA must be visible without scrolling');
    assert.equal(await zaloLink.getAttribute('target'), '_blank');
    assert.equal(await panel.locator('.co-gmap-big').count(), 0);
    if (process.env.WHEEL_PENDING_SCREENSHOT) {
      fs.mkdirSync(path.dirname(process.env.WHEEL_PENDING_SCREENSHOT), { recursive: true });
      await page.screenshot({ path: process.env.WHEEL_PENDING_SCREENSHOT, animations: 'disabled' });
    }
    console.log(`PASS ${ios ? 'iPhone/WebKit' : 'Android/Chromium'} small viewport shows Zalo CTA without the large icon`);
    // Avoid opening any real Zalo app: preserve React's click handler, cancel only navigation.
    await zaloLink.evaluate(el => el.addEventListener('click', e => e.preventDefault(), { once: true }));
    await zaloLink.click();
    await page.evaluate(() => history.back());
    await page.waitForFunction(({tableId,spinId}) => localStorage.getItem(`lucky_spin_${tableId}_pending`) === spinId
      && !localStorage.getItem(`lucky_spin_${tableId}_zalo_departure`), {tableId,spinId});
    await panel.waitFor({state:'visible'});
    assert.equal(await page.evaluate(tableId => localStorage.getItem(`lucky_spin_${tableId}_dismissed`), tableId), null);
    console.log('PASS returning Back preserves the task instead of marking the reward dismissed');
    // Some WebViews ignore target=_blank. Exercise a full document departure + Back too.
    await zaloLink.evaluate(el => el.addEventListener('click', e => e.preventDefault(), { once: true }));
    await zaloLink.click();
    await page.goto(`${base}/mock-zalo`);
    await page.goBack();
    await panel.waitFor({state:'visible'});
    await zaloLink.waitFor({state:'visible'});
    console.log('PASS same-tab fallback navigation and Back restore the pending reward');
    await capture('02-waiting-zalo');
    console.log('PASS mobile reload restores waiting reward');

    await panel.getByRole('button', { name: 'Để sau, tiếp tục gọi món' }).click();
    await page.reload();
    await page.getByText('Bàn 1', { exact: false }).first().waitFor();
    assert.equal(await panel.count(), 0);
    await page.locator('.co-promo-pill.wheel').click();
    await panel.getByText('Mở Zalo, bấm Quan tâm!', { exact: false }).waitFor();
    console.log('PASS choosing later stays closed; manual reopen resumes same reward');

    // Simulate server confirmation while the guest is away and a fresh page load.
    spin = { ...spin, status: 'applied' };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await panel.getByText('Đã mở quà!', { exact: false }).waitFor();
    console.log('PASS returning to existing tab advances to gift selection');
    await page.reload();
    await panel.getByText('Đã mở quà!', { exact: false }).waitFor();
    await capture('03-return-select');
    await panel.getByRole('button', { name: /Nước thử nghiệm/ }).click();
    await panel.getByRole('alert').filter({ hasText: 'Quà chưa được ghi' }).waitFor();
    assert.equal(await panel.getByText('Nhận quà thành công!', { exact: false }).count(), 0);
    await capture('04-retry-error');
    console.log('PASS failed gift keeps selection and displays error');
    failGift = false;
    await panel.getByRole('button', { name: /Nước thử nghiệm/ }).click();
    await panel.getByText('Nhận quà thành công!', { exact: false }).waitFor();
    assert.equal(giftRequests, 2);
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'panel fits mobile width');
    console.log('PASS successful retry confirms delivery on mobile');
    await capture('05-gift-success');
    await panel.getByRole('button', { name: /Đã nhận quà, gọi món tiếp/ }).click();
    await page.reload();
    await page.getByText('Bàn 1', { exact: false }).first().waitFor();
    assert.equal(await panel.count(), 0);
    console.log('PASS acknowledged gift stays closed after reload');

    spin = { ...spin, prize_type: 'percent', prize_value: 9, prize_label: 'Phần quà mới', discount_amount: 10000 };
    await page.evaluate(({ tableId, spinId }) => {
      localStorage.removeItem(`lucky_spin_${tableId}_dismissed`);
      localStorage.setItem(`lucky_spin_${tableId}_pending`, spinId);
    }, { tableId, spinId });
    await page.reload();
    await panel.getByText('Chúc mừng Quý khách được giảm 9% hoá đơn.', { exact: true }).waitFor();
    await panel.getByText(/Bill hiện được giảm.*10/).waitFor();
    await panel.getByText(/Tiền giảm tự cập nhật/).waitFor();
    console.log('PASS percentage and actual capped discount are shown');
    await capture('06-percent-success');
    if (process.env.WHEEL_SCREENSHOT) await page.screenshot({ path: process.env.WHEEL_SCREENSHOT, fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log('PASS no browser runtime errors; all business requests mocked');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
