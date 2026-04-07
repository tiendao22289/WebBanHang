const fs = require('fs');

function injectImport(content) {
  const importStatement = "import { removeVietnameseTones } from '@/lib/utils';\n";
  if (content.includes('removeVietnameseTones')) return content;
  
  // Insert after 'use client'; if it exists, or just at the top
  if (content.startsWith("'use client';")) {
    return content.replace("'use client';", "'use client';\n" + importStatement);
  } else if (content.startsWith('"use client";')) {
    return content.replace('"use client";', '"use client";\n' + importStatement);
  } else {
    return importStatement + content;
  }
}

function updateMenuAdmin() {
  const file = 'e:/Workspace/WebBanHang/src/app/admin/menu/page.jsx';
  let content = fs.readFileSync(file, 'utf8');
  content = injectImport(content);

  const oldSearch = `    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return i.name?.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q);
    }`;
  const newSearch = `    if (searchQuery.trim()) {
      const q = removeVietnameseTones(searchQuery);
      return removeVietnameseTones(i.name).includes(q) || removeVietnameseTones(i.description).includes(q);
    }`;
  content = content.replace(oldSearch, newSearch);

  fs.writeFileSync(file, content);
  console.log('admin/menu updated!');
}

function updateOrderApp() {
  const file = 'e:/Workspace/WebBanHang/src/app/order/page.jsx';
  let content = fs.readFileSync(file, 'utf8');
  content = injectImport(content);

  const oldSearch = `    const matchSearch = !searchTerm || item.name.toLowerCase().includes(searchTerm.toLowerCase());`;
  const newSearch = `    const matchSearch = !searchTerm || removeVietnameseTones(item.name).includes(removeVietnameseTones(searchTerm));`;
  content = content.replace(oldSearch, newSearch);

  fs.writeFileSync(file, content);
  console.log('order app updated!');
}

function updateTablesAdmin() {
  const file = 'e:/Workspace/WebBanHang/src/app/admin/tables/page.js';
  let content = fs.readFileSync(file, 'utf8');
  content = injectImport(content);

  const oldSearch1 = `                  const q = desktopSearch.trim().toLowerCase();
                  const results = menuItems.filter(m => m.name?.toLowerCase().includes(q)).slice(0, 8);`;
  const newSearch1 = `                  const q = removeVietnameseTones(desktopSearch);
                  const results = menuItems.filter(m => removeVietnameseTones(m.name).includes(q)).slice(0, 8);`;
  content = content.replace(oldSearch1, newSearch1);

  const oldSearch2 = `          const matchesSearch = item.name.toLowerCase().includes(addItemSearch.toLowerCase());`;
  const newSearch2 = `          const matchesSearch = removeVietnameseTones(item.name).includes(removeVietnameseTones(addItemSearch));`;
  content = content.replace(oldSearch2, newSearch2);

  fs.writeFileSync(file, content);
  console.log('admin/tables updated!');
}

try {
  updateMenuAdmin();
  updateOrderApp();
  updateTablesAdmin();
} catch (e) {
  console.error("Error updating files:", e);
}
