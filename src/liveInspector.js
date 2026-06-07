export async function inspectLiveCreator(page, creator) {
  const result = {
    checked: true,
    loaded: false,
    battleActive: false,
    leagueSignals: [],
    battleSignals: [],
    textSample: ''
  };

  try {
    await page.goto(creator.liveUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    const text = await page.evaluate(() => document.body?.innerText || '');

    result.loaded = text.length > 0;
    result.textSample = text.slice(0, 2000);

    const battleMatches = text.match(/VS|battle|match|rank/gi) || [];
    const leagueMatches = text.match(/league|ranking|daily|weekly|top/gi) || [];

    result.battleSignals = [...new Set(battleMatches)].slice(0, 20);
    result.leagueSignals = [...new Set(leagueMatches)].slice(0, 20);
    result.battleActive = result.battleSignals.length > 0;

    return result;
  } catch (error) {
    return {
      ...result,
      error: String(error?.message || error)
    };
  }
}
