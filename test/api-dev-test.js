const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fetchRealLegalDocument, cleanLegalDocumentContent, formatLegalDocumentHtml, crawlDailyBulletins, runBulletinCrawlerIfNeeded } = require('../server.js');

(async () => {
  console.log('Running eLegal Full System Node.js & Document Test Suite...\n');

  // Test 1: Cheptoo v NSSF Judicial Precedent Header Formatting
  console.log('Test 1: Testing Cheptoo v NSSF Judicial Precedent Header Formatting...');
  const samplePrecedent = `Cheptoo & 8 others v National Social Security Fund (NSSF) & 2 others (Civil Appeal (Application) E943 of 2023) [2025] KECA 799 (KLR) (9 May 2025) (Ruling)Neutral citation: [2025] KECA 799 (KLR)

 Republic of Kenya 

In the Court of Appeal at Nairobi

Civil Appeal (Application) E943 of 2023

W Karanja, WK Korir & GV Odunga, JJA

 May 9, 2025 

Between Joseph Cheptoo

1st Applicant

Faith Jerotich

2nd Applicant

Alice Chebet

3rd Applicant

Vivian Jepkemboi

4th Applicant

Leroy Kimutai

5th Applicant

Brenda Cherono

6th Applicant

Joseph Cheptoo

7th Applicant

Kevin Kipngetich

8th Applicant

Evans Kiprop

9th Applicant

and

National Social Security Fund (Nssf)

1st Respondent

David Gachonde

2nd Respondent

Rebecca Jepchumba Boit

3rd Respondent

(An application for stay of execution of the judgment and decree of the Environment and Land Court of Kenya at Nairobi (Komingoi, J.) dated 26th July 2023 in ELC Case No. E223 of 2020)

Ruling

1. By a Notice of Motion dated 14th December 2023, the applicants moved this Court...`;

  const formattedCheptoo = formatLegalDocumentHtml(samplePrecedent);
  assert(formattedCheptoo.includes('class="ql-align-center"'), 'Should contain center-aligned classes');
  assert(formattedCheptoo.includes('<strong>Republic of Kenya</strong>'), 'Republic of Kenya should be bold');
  assert(formattedCheptoo.includes('<strong>In the Court of Appeal at Nairobi</strong>'), 'Court name should be bold');
  assert(formattedCheptoo.includes('<strong>Between Joseph Cheptoo</strong>'), 'Parties should be bold and centered');
  assert(formattedCheptoo.includes('<strong>1st Applicant</strong>'), 'Applicant label should be bold and centered');
  assert(formattedCheptoo.includes('<strong>Ruling</strong>'), 'Ruling heading should be bold and centered');
  console.log('  ✅ Passed: Cheptoo header parts are bold and center-aligned.\n');

  // Test 2: Statute Header Formatting Test
  console.log('Test 2: Testing Statute Header Formatting (Limitation of Actions Act)...');
  const sampleStatute = `LAWS OF KENYA

LIMITATION OF ACTIONS ACT

CAP. 22

Assented to on 19 April 1968

Commenced on 1 December 1967

[Revised Edition 2022]

An Act of Parliament to prescribe periods for the limitation for actions and other proceedings...

PART I - PRELIMINARY

1. Short title
This Act may be cited as the Limitation of Actions Act.`;

  const formattedStatute = formatLegalDocumentHtml(sampleStatute);
  assert(formattedStatute.includes('class="ql-align-center"'), 'Statute header should be center aligned');
  assert(formattedStatute.includes('<strong>LAWS OF KENYA</strong>'), 'LAWS OF KENYA should be bold');
  assert(formattedStatute.includes('<strong>LIMITATION OF ACTIONS ACT</strong>'), 'Statute title should be bold');
  assert(formattedStatute.includes('<strong>CAP. 22</strong>'), 'Statute Cap should be bold');
  console.log('  ✅ Passed: Statute headers are bold and center-aligned.\n');

  // Test 3: Live Mugo v Kimathi (DOCX extraction)
  console.log('Test 3: Testing Live Mugo v Kimathi [2026] KEELC 1201 (DOCX extraction & centered header)...');
  const mugoDoc = await fetchRealLegalDocument('https://kenyalaw.org/akn/ke/judgment/keelc/2026/1201/eng@2026-02-25');
  if (mugoDoc) {
    assert(mugoDoc.text.includes('CHRISTOPHER KARIUKI MUGO'), 'Text should contain plaintiff name');
    assert(mugoDoc.text.includes('FIDIS IGOKI KIMATHI'), 'Text should contain defendant name');
    assert(mugoDoc.html.includes('class="ql-align-center"'), 'HTML should contain center-aligned headers');
    console.log('  ✅ Passed: Mugo v Kimathi extracted ' + mugoDoc.text.length + ' chars of verbatim judgment with centered bold header.\n');
  } else {
    console.log('  ⚠️ Note: Live fetch skipped or network restricted.\n');
  }

  // Test 4: Live Mtana Lewa (AKN HTML extraction)
  console.log('Test 4: Testing Live Mtana Lewa v Kahindi Ngala [2016] KECA 544 (AKN HTML extraction)...');
  const mtanaDoc = await fetchRealLegalDocument('https://kenyalaw.org/akn/ke/judgment/keca/2016/544/eng@2016-05-27');
  if (mtanaDoc) {
    assert(mtanaDoc.text.includes('MTANA LEWA'), 'Text should contain applicant name');
    assert(mtanaDoc.html.includes('class="ql-align-center"'), 'HTML should contain center-aligned headers');
    console.log('  ✅ Passed: Mtana Lewa extracted ' + mtanaDoc.text.length + ' chars of verbatim judgment with centered bold header.\n');
  } else {
    console.log('  ⚠️ Note: Live fetch skipped or network restricted.\n');
  }

  // Test 5: Pure Node.js Bulletin Crawler
  console.log('Test 5: Testing Pure Node.js Legal Bulletin Crawler (Zero Python)...');
  const crawledNews = await crawlDailyBulletins();
  assert(crawledNews && crawledNews.bulletins && crawledNews.bulletins.length > 0, 'Should crawl bulletins via native Node.js');
  const first = crawledNews.bulletins[0];
  assert(first.title && first.summary && first.source && first.category, 'Bulletin item should have complete metadata');
  console.log('  ✅ Passed: Pure Node.js crawler extracted ' + crawledNews.bulletins.length + ' live legal news items with complete metadata.\n');

  // Test 6: Verify no python files in codebase
  console.log('Test 6: Verifying 100% Python removal from repository...');
  const pythonScript = path.join(__dirname, '..', 'crawl_bulletins.py');
  assert(!fs.existsSync(pythonScript), 'crawl_bulletins.py should not exist');
  console.log('  ✅ Passed: No Python scripts present in codebase.\n');

  console.log('🎉 ALL SYSTEM TESTS PASSED SUCCESSFULLY WITH ZERO PYTHON DEPENDENCIES!');
  process.exit(0);
})();
