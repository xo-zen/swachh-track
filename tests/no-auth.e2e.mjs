// Run from browser_execute against the provisioned browser and a disposable seeded API.
// This module neither launches nor connects to a browser.
export async function runNoAuthChecks(session, baseUrl) {
  const results = [];
  const evaluate = async expression => {
    const result = await session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, action) => { await action(); results.push({ name, passed: true }); };
  const ready = `Boolean(document.querySelector('select[aria-label="Demo role"]'))`;
  const switchRole = async alias => {
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="Demo role"]'); select.value = ${JSON.stringify(alias)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(`${ready} && document.querySelector('select[aria-label="Demo role"]').value === ${JSON.stringify(alias)}`);
    await wait(`!document.querySelector('.loading-state')`);
  };
  await session.Page.enable();
  await session.Page.navigate({ url: baseUrl });
  await wait(ready);
  await check('Direct entry without login or logout UI', async () => {
    assert(await evaluate(`!document.querySelector('.login-page, input[name="phone"], input[name="code"], button[aria-label="Sign out"]')`), 'Login interface remains visible');
    assert(await evaluate(`document.querySelector('select[aria-label="Demo role"]').value === 'resident'`), 'Default role must be resident');
  });
  for (const alias of ['resident', 'society', 'collector', 'supervisor', 'ulb']) {
    await check(`Tokenless ${alias} workspace`, async () => {
      await switchRole(alias);
      assert(await evaluate(`!document.querySelector('.error-state, .login-page')`), `${alias} workspace failed`);
      assert(await evaluate(`document.querySelector('.sidebar nav').children.length > 0`), 'Role navigation missing');
    });
  }
  await check('Role survives reload with no sign-in', async () => {
    await session.Page.reload({}); await wait(ready);
    assert(await evaluate(`document.querySelector('select[aria-label="Demo role"]').value === 'ulb'`), 'Role was not remembered');
    assert(await evaluate(`!document.querySelector('.login-page')`), 'Reload showed login');
  });
  await check('Shared identities remain read-only', async () => {
    await switchRole('society');
    await evaluate(`document.querySelectorAll('.sidebar nav button')[2].click()`);
    await wait(`document.querySelector('.breadcrumb strong')?.textContent === 'Residents' && !document.querySelector('.loading-state')`);
    assert(await evaluate(`!Array.from(document.querySelectorAll('button')).some(button => ['Invite resident', 'Deactivate'].includes(button.textContent.trim()))`), 'Identity edit controls exposed');
  });
  await check('Phone width keeps role control and navigation usable', async () => {
    await session.Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Horizontal overflow');
    await evaluate(`document.querySelector('button[aria-label="Navigation"]').click()`);
    assert(await evaluate(`Boolean(document.querySelector('.sidebar.mobile-open'))`), 'Mobile menu did not open');
    await evaluate(`document.querySelector('.mobile-close').click()`);
    await wait(`!document.querySelector('.sidebar.mobile-open')`);
  });
  await check('Hindi labels work in the open demo', async () => {
    await evaluate(`(() => { const select = document.querySelector('.language-switch'); select.value = 'hi'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(`Boolean(document.querySelector('select[aria-label="डेमो भूमिका"]'))`);
    await evaluate(`(() => { const select = document.querySelector('.language-switch'); select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(ready);
  });
  await session.Emulation.setDeviceMetricsOverride({ width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await switchRole('resident');
  return results;
}
