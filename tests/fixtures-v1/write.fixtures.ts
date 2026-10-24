import { test } from '@playwright/test'
import { readDump } from '../../src/local/dump'
import {
    BUILD,
    stepA1,
    stepA10,
    stepA11,
    stepA12,
    stepA13,
    stepA2,
    stepA3,
    stepA4,
    stepA5,
    stepA6,
    stepA7,
    stepA8,
    stepA9,
    stopAfter,
} from './contextA'
import { runB } from './contextB'
import { runD } from './contextD'
import { runE } from './contextE'
import {
    emptyOutputFolders,
    processAll,
    processDownload,
    retagRawExport,
    writeFixtures,
} from './output'
import { Products } from './products'
import { nxspReadme, webReadme } from './readme'

// The v1 format fixtures' writer (`npm run fixtures:v1`; Part 1 §1.6.11.9). It drives the real
// editor through the scenario of work/release/fixtures/scenario.md and writes the fixtures only
// with NSE_WRITE_FIXTURES=1, and only into empty folders (NSE_FIXTURES_OUT=<dir> writes both
// folders under <dir> instead, for a dry run). Run it with TZ=UTC.

test('the v1 fixtures', async ({ browser }) => {
    test.skip(
        process.env.NSE_WRITE_FIXTURES !== '1',
        'Set NSE_WRITE_FIXTURES=1 to run the scenario and write the fixtures',
    )
    test.setTimeout(60 * 60_000)
    // Refuse before the long run, not after it.
    if (process.env.NSE_FIXTURES_STOP === undefined) emptyOutputFolders()
    const products = new Products()
    const { a, tab } = await stepA1(browser, products)
    if (stopAfter('A1')) return
    await stepA2(a, tab)
    if (stopAfter('A2')) return
    await stepA3(tab)
    if (stopAfter('A3')) return
    const visit4 = await stepA4(a, tab)
    if (stopAfter('A4')) return
    await stepA5(visit4)
    if (stopAfter('A5')) return
    const visit6 = await stepA6(a, visit4)
    if (stopAfter('A6')) return
    const visit7 = await stepA7(a, visit6)
    if (stopAfter('A7')) return
    await stepA8(a, visit7)
    if (stopAfter('A8')) return
    const visit9 = await stepA9(a, visit7)
    if (stopAfter('A9')) return
    const visit10 = await stepA10(a, visit9)
    if (stopAfter('A10')) return
    const visit11 = await stepA11(a, visit10)
    if (stopAfter('A11')) return
    await stepA12(a, visit11)
    if (stopAfter('A12')) return
    const dumpA = await stepA13(a, visit11)
    products.put('nse-local-data.raw.json', JSON.stringify(dumpA))
    if (stopAfter('A13')) return
    await runB(browser, products)
    if (stopAfter('B')) return
    const dumpD = await runD(browser, products)
    products.put('nse-local-data-download.raw.json', JSON.stringify(dumpD))
    if (stopAfter('D')) return
    await runE(browser, products)
    if (stopAfter('E')) return
    const dumps = {
        main: processAll(readDump(JSON.parse(JSON.stringify(dumpA))), a.chains),
        download: processDownload(readDump(JSON.parse(JSON.stringify(dumpD)))),
    }
    products.put('raw-export.zip', await retagRawExport(products.bytes('raw-export.zip')))
    const written = writeFixtures(products, dumps, {
        nxsp: nxspReadme(BUILD),
        web: webReadme(BUILD),
    })
    console.log(`Wrote ${written.nxsp} and ${written.web}`)
})
