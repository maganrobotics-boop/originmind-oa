// Follow the same visible navigation a member uses from the current OA homepage.
export async function openCollaborationWorkspace(page) {
  await page.locator('.oa-app').waitFor();
  const desktopNavigation = page.locator('.oa-desktop-navigation');
  let useDesktopNavigation = await desktopNavigation.isVisible();
  const expandDesktopNavigation = page.getByRole('button',{name:'展开侧栏',exact:true});
  if (!useDesktopNavigation && await expandDesktopNavigation.isVisible()) {
    await expandDesktopNavigation.click();
    await desktopNavigation.waitFor();
    useDesktopNavigation = true;
  }
  if (!useDesktopNavigation) await page.getByRole('button',{name:'打开导航',exact:true}).click();
  const navigation = useDesktopNavigation ? desktopNavigation : page.locator('.mobile-sidebar');
  await navigation.getByRole('navigation',{name:'核心工作区',exact:true}).getByRole('button',{name:'聊天',exact:true}).click();
  await page.locator('.collaboration-workspace').waitFor();
}
