import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn } from './support.js';

/*
 * 子任务 and 检查项 (EURO-9, spec 用户故事 35–37). Runs at 1440px and 390px.
 * Desktop uses Tab / Shift+Tab and mouse drag; mobile uses the detail menu
 * and 上移 / 下移 (no keyboard, no drag on touch).
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const completedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const subtasksOf = (scope: Locator | Page, title: string) => scope.getByRole('list', { name: `「${title}」的子任务` });
const titleButton = (scope: Locator | Page, title: string) => scope.getByRole('button', { name: title, exact: true });
const items = (page: Page) => detail(page).getByRole('list', { name: '检查项' });

async function addTasks(page: Page, ...titles: string[]) {
  for (const title of titles) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(titleButton(openTasks(page), title)).toBeVisible();
  }
}

async function openTask(page: Page, title: string) {
  await titleButton(openTasks(page), title).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
}

async function backToList(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
}

/** Add a 子任务 to the task open in the detail pane. */
async function addSubtask(page: Page, title: string) {
  const input = detail(page).getByRole('textbox', { name: '添加子任务' });
  await input.fill(title);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(detail(page).getByRole('list', { name: '子任务列表' }).getByRole('button', { name: title, exact: true })).toBeVisible();
}

/** Tab (desktop keyboard) or the detail menu (mobile). */
async function indent(page: Page, title: string, outdent = false) {
  if (isMobile(page)) {
    await openTask(page, title);
    await detail(page).getByRole('button', { name: '任务更多操作' }).click();
    await page.getByRole('menuitem', { name: outdent ? /取消缩进/ : /^缩进/ }).click();
    await backToList(page);
  } else {
    await openTask(page, title);
    await titleButton(openTasks(page), title).focus();
    await page.keyboard.press(outdent ? 'Shift+Tab' : 'Tab');
  }
}

async function itemTexts(page: Page): Promise<string[]> {
  const inputs = items(page).getByRole('textbox');
  const n = await inputs.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await inputs.nth(i).inputValue());
  return out;
}

test('子任务: add in the detail pane, Tab / Shift+Tab, completing the parent completes the 子任务', async ({ page }, testInfo) => {
  const user = createUser('subtasks');
  await logIn(page, user.username, user.password);
  await addTasks(page, '买灯', '量尺寸', '装修');
  await expect(openTasks(page).getByRole('button')).toHaveText(['装修', '量尺寸', '买灯']);

  // Add 子任务 from the detail pane: they nest under 装修 in the list.
  await openTask(page, '装修');
  await addSubtask(page, '选瓷砖');
  await addSubtask(page, '找施工队');
  await backToList(page);
  await expect(subtasksOf(page, '装修').getByRole('button')).toHaveText(['选瓷砖', '找施工队']);

  // Tab: 量尺寸 becomes the last 子任务 of 装修 (the task above it). Shift+Tab undoes it.
  await indent(page, '量尺寸');
  await expect(subtasksOf(page, '装修').getByRole('button')).toHaveText(['选瓷砖', '找施工队', '量尺寸']);
  if (!isMobile(page)) await expect(titleButton(openTasks(page), '量尺寸')).toBeFocused();
  // Tab again: under 找施工队, a third level.
  await indent(page, '量尺寸');
  await expect(subtasksOf(page, '找施工队').getByRole('button')).toHaveText(['量尺寸']);
  await indent(page, '量尺寸', true);
  await expect(subtasksOf(page, '装修').getByRole('button')).toHaveText(['选瓷砖', '找施工队', '量尺寸']);
  await page.reload();
  await expect(subtasksOf(page, '装修').getByRole('button')).toHaveText(['选瓷砖', '找施工队', '量尺寸']);

  // Collapse / expand the 子任务 of 装修.
  const toggle = openTasks(page).getByRole('button', { name: '收起「装修」的子任务' });
  await toggle.click();
  await expect(subtasksOf(page, '装修')).toHaveCount(0);
  await openTasks(page).getByRole('button', { name: '展开「装修」的子任务' }).click();
  await expect(subtasksOf(page, '装修').getByRole('button')).toHaveText(['选瓷砖', '找施工队', '量尺寸']);
  await page.screenshot({ path: testInfo.outputPath(`subtasks-list-${testInfo.project.name}.png`) });

  // The detail of a 子任务 links back to its parent.
  await openTask(page, '选瓷砖');
  await detail(page).getByRole('button', { name: /父任务：装修/ }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue('装修');
  await expect(detail(page).getByRole('heading', { name: /子任务\s*0\/3/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`subtasks-${testInfo.project.name}.png`) });
  await backToList(page);

  // Completing 装修 completes all of its 子任务; they move to 已完成 with it, still nested.
  await openTasks(page).getByRole('checkbox', { name: '装修' }).click();
  const done = subtasksOf(completedTasks(page), '装修');
  for (const title of ['选瓷砖', '找施工队', '量尺寸']) await expect(done.getByRole('checkbox', { name: title })).toBeChecked();
  await expect(openTasks(page).getByRole('button')).toHaveText(['买灯']);
  await page.reload();
  await expect(subtasksOf(completedTasks(page), '装修').getByRole('checkbox', { name: '量尺寸' })).toBeChecked();

  // Re-opening one 子任务 re-opens its parent; the other 子任务 stay completed.
  await subtasksOf(completedTasks(page), '装修').getByRole('checkbox', { name: '量尺寸' }).click();
  await expect(subtasksOf(openTasks(page), '装修').getByRole('checkbox', { name: '量尺寸' })).not.toBeChecked();
  await expect(openTasks(page).getByRole('checkbox', { name: '装修' })).not.toBeChecked();
  await expect(completedTasks(page).getByRole('checkbox', { name: '选瓷砖' })).toBeChecked();
});

test('子任务 stop at 5 levels: adding a 6th level is refused with a message', async ({ page }) => {
  const user = createUser('depth');
  await logIn(page, user.username, user.password);
  await addTasks(page, 'L1');
  await openTask(page, 'L1');
  for (const [parent, child] of [['L1', 'L2'], ['L2', 'L3'], ['L3', 'L4'], ['L4', 'L5']] as const) {
    await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(parent);
    await addSubtask(page, child);
    await detail(page).getByRole('list', { name: '子任务列表' }).getByRole('button', { name: child, exact: true }).click();
  }
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue('L5');

  // A 子任务 of L5 would be level 6.
  const input = detail(page).getByRole('textbox', { name: '添加子任务' });
  await input.fill('L6');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('子任务最多 5 层');
  await expect(input).toHaveValue('L6'); // nothing typed is lost
  await page.getByRole('button', { name: '知道了' }).click();

  // Tab that would push a task to level 6 is refused too.
  await detail(page).getByRole('button', { name: /父任务：L4/ }).click();
  await addSubtask(page, 'X'); // X: level 5, sibling after L5
  await backToList(page);
  await indent(page, 'X');
  await expect(page.getByRole('alert')).toContainText('子任务最多 5 层');
  await expect(subtasksOf(page, 'L4').getByRole('button', { name: /^(L5|X)$/ })).toHaveText(['L5', 'X']);
  await page.reload();
  await expect(subtasksOf(page, 'L5')).toHaveCount(0);
});

test('检查清单: convert from 描述, check, add, reorder, delete, convert back', async ({ page }, testInfo) => {
  const user = createUser('checklist');
  await logIn(page, user.username, user.password);
  await addTasks(page, '出差');
  await openTask(page, '出差');
  const description = detail(page).getByRole('textbox', { name: '描述' });
  await description.fill('订机票\n\n- 订酒店\n打印行程单');
  await description.blur();
  await expect(detail(page).getByRole('region', { name: '描述' })).toContainText('订酒店');

  // 描述 → 检查清单: one 检查项 per non-empty line, list markers dropped.
  await detail(page).getByRole('button', { name: '切换为检查清单' }).click();
  await expect(items(page).getByRole('checkbox')).toHaveCount(3);
  expect(await itemTexts(page)).toEqual(['订机票', '订酒店', '打印行程单']);
  await expect(detail(page).getByRole('region', { name: '描述' })).toHaveCount(0);

  // Check one and add one.
  await items(page).getByRole('checkbox', { name: '订机票' }).click();
  await expect(items(page).getByRole('checkbox', { name: '订机票' })).toBeChecked();
  const add = detail(page).getByRole('textbox', { name: '添加检查项' });
  await add.fill('带护照');
  await add.press('Enter');
  await expect(add).toHaveValue('');
  await expect(add).toBeFocused();
  expect(await itemTexts(page)).toEqual(['订机票', '订酒店', '打印行程单', '带护照']);

  // Rename.
  await items(page).getByRole('textbox', { name: '检查项 3' }).fill('打印行程');
  await items(page).getByRole('textbox', { name: '检查项 3' }).press('Enter');
  await expect(items(page).getByRole('checkbox', { name: '打印行程' })).toBeVisible();

  // Reorder: 带护照 to the top (drag on desktop, 上移 on mobile).
  if (isMobile(page)) {
    for (let i = 0; i < 3; i++) {
      await items(page).getByRole('button', { name: '检查项「带护照」更多操作' }).click();
      await page.getByRole('menuitem', { name: '上移' }).click();
    }
  } else {
    const rows = items(page).getByRole('listitem');
    await rows.filter({ has: page.getByRole('checkbox', { name: '带护照' }) }).dragTo(rows.first(), {
      sourcePosition: { x: 6, y: 12 }, // the grip
      targetPosition: { x: 40, y: 4 },
    });
  }
  await expect.poll(() => itemTexts(page)).toEqual(['带护照', '订机票', '订酒店', '打印行程']);

  // Delete.
  await items(page).getByRole('button', { name: '删除检查项「订酒店」' }).click();
  await expect.poll(() => itemTexts(page)).toEqual(['带护照', '订机票', '打印行程']);

  // Everything is on the server.
  await page.reload();
  await expect(openTasks(page).getByText('检查清单')).toBeAttached();
  await openTask(page, '出差');
  await expect.poll(() => itemTexts(page)).toEqual(['带护照', '订机票', '打印行程']);
  await expect(items(page).getByRole('checkbox', { name: '订机票' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath(`checklist-${testInfo.project.name}.png`) });

  // 检查清单 → 描述: one line per 检查项.
  await detail(page).getByRole('button', { name: '切换为描述' }).click();
  await expect(items(page)).toHaveCount(0);
  await detail(page).getByRole('button', { name: '编辑描述' }).click();
  await expect(detail(page).getByRole('textbox', { name: '描述' })).toHaveValue('带护照\n订机票\n打印行程');
});
