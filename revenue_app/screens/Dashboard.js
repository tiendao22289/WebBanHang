import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../supabase';
import { Banknote, CreditCard, TrendingUp, Calendar as CalendarIcon, Building2, Trash2, X, Clock, Receipt } from 'lucide-react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

export default function DashboardScreen() {
  const [stats, setStats] = useState({
    total: 0,
    cash: 0,
    transfer: 0,
    ordersCount: 0,
    banks: []
  });
  const [refreshing, setRefreshing] = useState(false);
  const [filterType, setFilterType] = useState('today'); // 'today' | 'month' | 'custom'
  const [customDate, setCustomDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);



  const fetchStats = async () => {
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
        .select('amount, payment_method, bank_account_number, bank_account_name')
        .gte('created_at', startDateStr)
        .lte('created_at', endDateStr);

      if (error) throw error;

      let cash = 0;
      let transfer = 0;
      let bankTotals = {};
      
      data.forEach(log => {
        if (log.payment_method === 'cash') {
          cash += log.amount;
        }
        if (log.payment_method === 'transfer') {
          transfer += log.amount;
          
          if (log.bank_account_number) {
            const key = `${log.bank_account_name || 'Ngân hàng'} - ${log.bank_account_number}`;
            if (!bankTotals[key]) {
              bankTotals[key] = {
                name: log.bank_account_name || 'Ngân hàng',
                number: log.bank_account_number,
                total: 0
              };
            }
            bankTotals[key].total += log.amount;
          }
        }
      });

      setStats({
        total: cash + transfer,
        cash,
        transfer,
        ordersCount: data.length,
        banks: Object.values(bankTotals).sort((a, b) => b.total - a.total)
      });



    } catch (e) {
      console.error('Error fetching stats:', e);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchStats();
    
    // Realtime subscription
    const channel = supabase
      .channel('public:actual_revenue_logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'actual_revenue_logs' }, (payload) => {
        fetchStats(); 
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [filterType, customDate]);

  const formatDate = (dateString) => {
    const d = new Date(dateString);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
  };

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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Quản lý Doanh thu</Text>
        <Text style={styles.subtitle}>Dữ liệu thực tế được đồng bộ tự động</Text>
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

      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={[styles.card, styles.mainCard]}>
          <View style={styles.cardHeader}>
            <TrendingUp color="#fff" size={24} />
            <Text style={styles.mainCardLabel}>Tổng doanh thu</Text>
          </View>
          <Text style={styles.mainCardValue}>{formatMoney(stats.total)}</Text>
          <Text style={styles.mainCardSubValue}>{stats.ordersCount} đơn hàng</Text>
        </View>

        <View style={styles.row}>
          <View style={[styles.card, styles.halfCard]}>
            <Banknote color="#16a34a" size={28} />
            <Text style={styles.cardLabel}>Tiền mặt</Text>
            <Text style={[styles.cardValue, { color: '#16a34a' }]}>{formatMoney(stats.cash)}</Text>
          </View>

          <View style={[styles.card, styles.halfCard]}>
            <CreditCard color="#2563eb" size={28} />
            <Text style={styles.cardLabel}>Chuyển khoản</Text>
            <Text style={[styles.cardValue, { color: '#2563eb' }]}>{formatMoney(stats.transfer)}</Text>
          </View>
        </View>

        <View style={styles.section}>
            <Text style={styles.sectionTitle}>Nguồn Chuyển khoản</Text>
            {stats.banks.map((bank, index) => (
              <View key={index} style={styles.bankCard}>
                <View style={styles.bankIcon}>
                  <Building2 color="#3b82f6" size={24} />
                </View>
                <View style={styles.bankDetails}>
                  <Text style={styles.bankName}>{bank.name}</Text>
                  <Text style={styles.bankNumber}>{bank.number}</Text>
                </View>
                <Text style={styles.bankTotal}>{formatMoney(bank.total)}</Text>
              </View>
            ))}
        </View>
      </ScrollView>
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
    padding: 15,
    gap: 10
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
  scrollContent: {
    padding: 15,
    gap: 15
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  mainCard: {
    backgroundColor: '#0f172a',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 15
  },
  mainCardLabel: {
    color: '#cbd5e1',
    fontSize: 16,
    fontWeight: '600'
  },
  mainCardValue: {
    color: 'white',
    fontSize: 32,
    fontWeight: 'bold',
  },
  mainCardSubValue: {
    color: '#94a3b8',
    fontSize: 14,
    marginTop: 8,
    fontWeight: '500'
  },
  row: {
    flexDirection: 'row',
    gap: 15
  },
  halfCard: {
    flex: 1,
    alignItems: 'flex-start'
  },
  cardLabel: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6
  },
  cardValue: {
    fontSize: 20,
    fontWeight: 'bold'
  },
  section: {
    marginTop: 10
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 12
  },
  bankCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    padding: 16,
    borderRadius: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 5,
    elevation: 2,
  },
  bankIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 15
  },
  bankDetails: {
    flex: 1
  },
  bankName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#1e293b'
  },
  bankNumber: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2
  },
  bankTotal: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#3b82f6'
  },

});
