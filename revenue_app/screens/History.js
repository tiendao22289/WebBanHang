import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../supabase';
import { Banknote, CreditCard, User, Clock, Receipt, X, Building2 } from 'lucide-react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

export default function HistoryScreen() {
  const [logs, setLogs] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLog, setSelectedLog] = useState(null);

  const [filterType, setFilterType] = useState('today'); // 'today' | 'month' | 'custom'
  const [customDate, setCustomDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  const fetchHistory = async () => {
    try {
      const now = filterType === 'custom' ? customDate : new Date();
      let startDateStr = '';
      let endDateStr = '';
      
      if (filterType === 'today' || filterType === 'custom') {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        startDateStr = startOfDay.toISOString();
        endDateStr = endOfDay.toISOString();
      } else if (filterType === 'month') {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        startDateStr = startOfMonth.toISOString();
        endDateStr = endOfMonth.toISOString();
      }

      const { data, error } = await supabase
        .from('actual_revenue_logs')
        .select('*')
        .gte('created_at', startDateStr)
        .lte('created_at', endDateStr)
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;
      setLogs(data || []);
    } catch (e) {
      console.error('Error fetching history:', e);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchHistory();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchHistory();
    
    // Realtime subscription
    const channel = supabase
      .channel('public:actual_revenue_logs_history')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'actual_revenue_logs' }, (payload) => {
        setLogs(prev => [payload.new, ...prev]);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [filterType, customDate]);

  const onChangeDate = (event, selectedDate) => {
    setShowDatePicker(false);
    if (selectedDate) {
      setCustomDate(selectedDate);
      setFilterType('custom');
    }
  };

  const formatMoney = (val) => {
    return new Intl.NumberFormat('vi-VN').format(val) + ' đ';
  };

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
  };

  const getSourceLabel = (source, tableNumber) => {
    switch(source) {
      case 'qr_cash': return 'Mã QR (Tiền mặt)';
      case 'qr_transfer': return 'Mã QR (Chuyển khoản)';
      case 'table_cash': return `Bàn ${tableNumber || '?'} (Tiền mặt)`;
      case 'table_transfer': return `Bàn ${tableNumber || '?'} (Chuyển khoản)`;
      default: return source;
    }
  };

  const renderItem = ({ item }) => (
    <TouchableOpacity style={styles.logItem} onPress={() => setSelectedLog(item)}>
      <View style={styles.logHeader}>
        <View style={styles.logIcon}>
          {item.payment_method === 'cash' ? (
            <Banknote color="#16a34a" size={24} />
          ) : (
            <CreditCard color="#2563eb" size={24} />
          )}
        </View>
        <View style={styles.logDetails}>
          <View style={styles.logRow}>
            <Text style={styles.logSource}>{getSourceLabel(item.source, item.table_number)}</Text>
            <Text style={[styles.logAmount, { color: item.payment_method === 'cash' ? '#16a34a' : '#2563eb' }]}>
              +{formatMoney(item.amount)}
            </Text>
          </View>
          <View style={styles.logRow}>
            <View style={styles.infoBadge}>
              <User size={12} color="#64748b" />
              <Text style={styles.infoText}>{item.staff_name || 'Hệ thống'}</Text>
            </View>
            <View style={styles.infoBadge}>
              <Clock size={12} color="#64748b" />
              <Text style={styles.infoText}>{formatDate(item.created_at)}</Text>
            </View>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Lịch sử Giao dịch</Text>
        <Text style={styles.subtitle}>Hiển thị tối đa 200 giao dịch</Text>
      </View>

      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
          <Text 
            style={[styles.filterTab, filterType === 'today' && styles.filterTabActive]}
            onPress={() => setFilterType('today')}
          >
            Hôm nay
          </Text>
          <Text 
            style={[styles.filterTab, filterType === 'month' && styles.filterTabActive]}
            onPress={() => setFilterType('month')}
          >
            Tháng này
          </Text>
          <Text 
            style={[styles.filterTab, filterType === 'custom' && styles.filterTabActive]}
            onPress={() => setShowDatePicker(true)}
          >
            {filterType === 'custom' 
              ? `${customDate.getDate().toString().padStart(2, '0')}/${(customDate.getMonth()+1).toString().padStart(2, '0')}/${customDate.getFullYear()}` 
              : 'Chọn ngày...'}
          </Text>
        </ScrollView>
      </View>

      {showDatePicker && (
        <DateTimePicker
          value={customDate}
          mode="date"
          display="default"
          onChange={onChangeDate}
        />
      )}

      <FlatList
        data={logs}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>Chưa có giao dịch nào.</Text>
          </View>
        }
      />

      <Modal
        visible={!!selectedLog}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setSelectedLog(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedLog && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Chi tiết Giao dịch</Text>
                  <TouchableOpacity onPress={() => setSelectedLog(null)} style={styles.closeButton}>
                    <X size={24} color="#64748b" />
                  </TouchableOpacity>
                </View>

                <ScrollView style={styles.modalBody}>
                  <View style={styles.billBox}>
                    <Text style={styles.billCode}>Mã Bill: #{selectedLog.id.substring(0, 8).toUpperCase()}</Text>
                    <Text style={styles.billTotal}>{formatMoney(selectedLog.amount)}</Text>
                    <Text style={styles.billMethod}>
                      {selectedLog.payment_method === 'cash' ? 'Thanh toán bằng Tiền mặt' : 'Thanh toán bằng Chuyển khoản'}
                    </Text>
                  </View>

                  <View style={styles.infoSection}>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoLabel}>Nguồn:</Text>
                      <Text style={styles.infoValue}>{getSourceLabel(selectedLog.source, selectedLog.table_number)}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoLabel}>Nhân viên:</Text>
                      <Text style={styles.infoValue}>{selectedLog.staff_name || 'Hệ thống'}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoLabel}>Thời gian:</Text>
                      <Text style={styles.infoValue}>{formatDate(selectedLog.created_at)}</Text>
                    </View>
                    
                    {selectedLog.payment_method === 'transfer' && selectedLog.bank_account_number && (
                      <View style={styles.bankInfoRow}>
                        <Building2 size={16} color="#3b82f6" />
                        <View style={{ marginLeft: 8 }}>
                          <Text style={styles.bankNameLabel}>{selectedLog.bank_account_name || 'Ngân hàng'}</Text>
                          <Text style={styles.bankNumberLabel}>{selectedLog.bank_account_number}</Text>
                        </View>
                      </View>
                    )}
                  </View>

                  {selectedLog.order_details && selectedLog.order_details.length > 0 && (
                    <View style={styles.dishList}>
                      <Text style={styles.dishListTitle}>Danh sách món ăn:</Text>
                      {selectedLog.order_details.map((dish, index) => (
                        <View key={index} style={styles.modalDishRow}>
                          <Text style={styles.modalDishQty}>{dish.qty}x</Text>
                          <View style={styles.modalDishInfo}>
                            <Text style={styles.modalDishName}>{dish.name}</Text>
                            <Text style={styles.modalDishUnit}>{formatMoney(dish.price)}/món</Text>
                          </View>
                          <Text style={styles.modalDishTotal}>{formatMoney(dish.price * dish.qty)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    padding: 20,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 4
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: 5,
    backgroundColor: '#f8fafc'
  },
  filterTab: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: '#e2e8f0',
    color: '#475569',
    fontWeight: 'bold',
    overflow: 'hidden'
  },
  filterTabActive: {
    backgroundColor: '#0f172a',
    color: 'white',
  },
  listContainer: {
    padding: 15,
  },
  logItem: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 5,
    elevation: 2,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 15
  },
  logDetails: {
    flex: 1,
    gap: 8
  },
  logRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  logSource: {
    fontSize: 15,
    fontWeight: '700',
    color: '#334155'
  },
  logAmount: {
    fontSize: 16,
    fontWeight: 'bold'
  },
  infoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8
  },
  infoText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '500'
  },
  emptyState: {
    padding: 40,
    alignItems: 'center'
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 16
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end'
  },
  modalContent: {
    backgroundColor: 'white',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: '80%',
    padding: 20
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingBottom: 15
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#0f172a'
  },
  closeButton: {
    padding: 5
  },
  modalBody: {
    flex: 1
  },
  billBox: {
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    padding: 20,
    borderRadius: 16,
    marginBottom: 20
  },
  billCode: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: 'bold',
    marginBottom: 8
  },
  billTotal: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 4
  },
  billMethod: {
    fontSize: 14,
    color: '#2563eb',
    fontWeight: '600'
  },
  infoSection: {
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    padding: 15,
    marginBottom: 20
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8
  },
  infoLabel: {
    fontSize: 15,
    color: '#64748b',
    fontWeight: '500'
  },
  infoValue: {
    fontSize: 15,
    color: '#0f172a',
    fontWeight: '600'
  },
  bankInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#eff6ff',
    padding: 10,
    borderRadius: 8
  },
  bankNameLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1e293b'
  },
  bankNumberLabel: {
    fontSize: 13,
    color: '#3b82f6',
    fontWeight: '500'
  },
  dishList: {
    marginTop: 10
  },
  dishListTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 15
  },
  modalDishRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  modalDishQty: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2563eb',
    width: 30
  },
  modalDishInfo: {
    flex: 1,
    paddingRight: 10
  },
  modalDishName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a'
  },
  modalDishUnit: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2
  },
  modalDishTotal: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a'
  }
});
