const fs = require('fs');

function refactorAdmin() {
  const file = 'e:/Workspace/WebBanHang/src/app/admin/tables/page.js';
  let content = fs.readFileSync(file, 'utf8');

  content = content.replace(/orders\[selectedTable\.id\]/g, "orders[selectedTable.merged_with || selectedTable.id]");
  content = content.replace(/orders\[table\.id\]/g, "orders[table.merged_with || table.id]");
  content = content.replace(/orders\[confirmPayment\.table\.id\]/g, "orders[confirmPayment.table.merged_with || confirmPayment.table.id]");
  content = content.replace(/\.eq\('table_id', selectedTable\.id\)/g, ".eq('table_id', selectedTable.merged_with || selectedTable.id)");
  content = content.replace(/table_id: selectedTable\.id,/g, "table_id: selectedTable.merged_with || selectedTable.id,");

  const newHandleMerge = `    if (targetTableId) {
      // Bàn hiện tại có thể đã là con của bàn khác, nên lấy activeTableId
      const activeTableId = selectedTable.merged_with || selectedTable.id;
      const currentOrders = orders[activeTableId] || [];
      const orderIds = currentOrders.map(o => o.id);
      
      if (orderIds.length > 0) {
        const { error } = await supabase
          .from('orders')
          .update({ table_id: targetTableId })
          .in('id', orderIds);
          
        if (error) {
          Swal.fire('Lỗi', error.message, 'error');
          return;
        }
      }
      
      await supabase.from('tables').update({ status: 'occupied', occupied_at: new Date().toISOString() }).eq('id', targetTableId);

      // Bàn hiện hành được GIỮ lại, kết nối với bàn mới
      await supabase.from('tables').update({ status: 'occupied', merged_with: targetTableId }).eq('id', selectedTable.id);
      
      fetchTables();
      setSelectedTable(null);
      
      Swal.fire({
        title: 'Thành công',
        text: 'Đã liên kết 2 bàn thành công!',
        icon: 'success',
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 2000
      });
    }`;
  content = content.replace(/    if \(targetTableId\) \{[\s\S]*?Swal\.fire\(\{[\s\S]*?timer: 2000\n      \}\);\n    \}/, newHandleMerge);

  const oldCompleteTable = `  async function completeTable(tableId, paymentMethod = 'cash') {
    await supabase
      .from('orders')
      .update({ status: 'paid', payment_method: paymentMethod })
      .eq('table_id', tableId)
      .in('status', ['pending', 'preparing', 'completed']);

    await supabase
      .from('tables')
      .update({ status: 'available', occupied_at: null })
      .eq('id', tableId);

    setSelectedTable(null);
    fetchTables();
  }`;
  const newCompleteTable = `  async function completeTable(tableId, paymentMethod = 'cash') {
    const t = tables.find(tb => tb.id === tableId);
    const mId = t?.merged_with || tableId;

    await supabase
      .from('orders')
      .update({ status: 'paid', payment_method: paymentMethod })
      .eq('table_id', mId)
      .in('status', ['pending', 'preparing', 'completed']);

    await supabase
      .from('tables')
      .update({ status: 'available', occupied_at: null, merged_with: null })
      .or(\`id.eq.\${mId},merged_with.eq.\${mId}\`);

    setSelectedTable(null);
    fetchTables();
  }`;
  content = content.replace(oldCompleteTable, newCompleteTable);

  const oldCancelDb = `                  await supabase.from('orders')
                    .update({ status: 'cancelled', payment_method: 'cancelled' })
                    .eq('table_id', t.id)
                    .in('status', ['pending', 'preparing', 'completed']);
                  await supabase.from('tables')
                    .update({ status: 'available', occupied_at: null })
                    .eq('id', t.id);`;
  const newCancelDb = `                  const mId = t.merged_with || t.id;
                  await supabase.from('orders')
                    .update({ status: 'cancelled', payment_method: 'cancelled' })
                    .eq('table_id', mId)
                    .in('status', ['pending', 'preparing', 'completed']);
                  await supabase.from('tables')
                    .update({ status: 'available', occupied_at: null, merged_with: null })
                    .or(\`id.eq.\${mId},merged_with.eq.\${mId}\`);`;
  content = content.replace(oldCancelDb, newCancelDb);

  const oldCancelOrderModal = `        const doCancelOrder = async () => {
          if (!window.confirm('Bạn có chắc muốn huỷ tất cả đơn của bàn này?')) return;
          await supabase.from('orders')
            .update({ status: 'cancelled', payment_method: 'cancelled' })
            .eq('table_id', table.id)
            .in('status', ['pending', 'preparing', 'completed']);
          await supabase.from('tables')
            .update({ status: 'available', occupied_at: null })
            .eq('id', table.id);`;
  const newCancelOrderModal = `        const doCancelOrder = async () => {
          if (!window.confirm('Bạn có chắc muốn huỷ tất cả đơn của bàn này?')) return;
          const mId = table.merged_with || table.id;
          await supabase.from('orders')
            .update({ status: 'cancelled', payment_method: 'cancelled' })
            .eq('table_id', mId)
            .in('status', ['pending', 'preparing', 'completed']);
          await supabase.from('tables')
            .update({ status: 'available', occupied_at: null, merged_with: null })
            .or(\`id.eq.\${mId},merged_with.eq.\${mId}\`);`;
  content = content.replace(oldCancelOrderModal, newCancelOrderModal);

  fs.writeFileSync(file, content);
  console.log('page.js updated!');
}

function refactorOrder() {
  const file = 'e:/Workspace/WebBanHang/src/app/order/page.jsx';
  let content = fs.readFileSync(file, 'utf8');

  // Change `const tableId...` to `const [activeTableId, setActiveTableId] = useState(searchParams.get('table'));`
  content = content.replace(/const tableId = searchParams\.get\('table'\);/, `const urlTableId = searchParams.get('table');\n  const [activeTableId, setActiveTableId] = useState(urlTableId);`);
  
  // Now replace all uses of `tableId` with `activeTableId` EXCEPT where it's used as query params
  // To be perfectly safe, I will only replace specific things:
  content = content.replace(/tableId \? supabase/g, "activeTableId ? supabase");
  
  // In fetchMenu, handle tableData.merged_with
  const oldFetchTableData = `.select('table_number, status, table_type, table_name').eq('id', activeTableId).single()`;
  const newFetchTableData = `.select('table_number, status, table_type, table_name, merged_with').eq('id', activeTableId).single()`;
  content = content.replace(oldFetchTableData, newFetchTableData);

  const addMergedWithLogic = `    if (tableData) {
      setTableNumber(isTW ? (tableData.table_name || 'Mang về') : tableData.table_number);
      setIsTakeaway(isTW);`;
  const newMergedWithLogic = `    if (tableData) {
      setTableNumber(isTW ? (tableData.table_name || 'Mang về') : tableData.table_number);
      setIsTakeaway(isTW);
      if (tableData.merged_with) {
        setActiveTableId(tableData.merged_with);
      }`;
  content = content.replace(addMergedWithLogic, newMergedWithLogic);

  // Replace dependencies array for useEffect from `[tableId]` to `[activeTableId]`
  content = content.replace(/\[tableId\]\); \/\/ eslint-disable-line react-hooks\/exhaustive-deps/g, `[activeTableId]); // eslint-disable-line react-hooks/exhaustive-deps`);
  content = content.replace(/if \(\!tableId\) return;/g, `if (!activeTableId) return;`);
  
  // Replace references in string interpolation and eq queries
  content = content.replace(/\{tableId\}/g, `{activeTableId}`);
  content = content.replace(/\.eq\('id', tableId\)/g, `.eq('id', activeTableId)`);
  content = content.replace(/\({ tableId,/g, `({ tableId: activeTableId,`);
  content = content.replace(/tableId !== tableId/g, `saved.tableId !== activeTableId`); 
  content = content.replace(/\.eq\('table_id', tableId\)/g, `.eq('table_id', activeTableId)`);
  content = content.replace(/table_id: tableId,/g, `table_id: activeTableId,`);
  content = content.replace(/`order-page-\$\{tableId\}-\$\{Date.now\(\)\}`/g, "`order-page-${activeTableId}-${Date.now()}`");
  content = content.replace(/`id=eq\.\$\{tableId\}`/g, "`id=eq.${activeTableId}`");
  content = content.replace(/`table_id=eq\.\$\{tableId\}`/g, "`table_id=eq.${activeTableId}`");

  fs.writeFileSync(file, content);
  console.log('page.jsx updated!');
}

try {
  refactorAdmin();
  refactorOrder();
} catch(e) {
  console.error("Error running script:", e);
}
