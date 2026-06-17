'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { MessageSquare, Phone, RefreshCw, Search, Star, User } from 'lucide-react';
import './reviews.css';

export default function ReviewsPage() {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    fetchReviews();
  }, []);

  async function fetchReviews() {
    setLoading(true);
    const { data: orderReviews, error: orderError } = await supabase
      .from('orders')
      .select(`
        id,
        customer_id,
        customer_name,
        customer_phone,
        customer_rating,
        customer_feedback,
        total_amount,
        created_at,
        table:tables(table_number),
        customer:customers(name, phone)
      `)
      .or('customer_rating.not.is.null,customer_feedback.not.is.null')
      .order('created_at', { ascending: false });

    const { data: generalReviews, error: generalError } = await supabase
      .from('customer_reviews')
      .select(`
        id,
        customer_name,
        customer_phone,
        rating,
        feedback,
        created_at,
        table:tables(table_number)
      `)
      .order('created_at', { ascending: false });

    if (orderError) console.error('fetch order reviews error:', orderError);
    if (generalError && generalError.code !== '42P01') console.error('fetch general reviews error:', generalError);

    const normalizedOrderReviews = (orderReviews || []).map(review => ({
      ...review,
      source: 'order',
      rating: review.customer_rating,
      feedback: review.customer_feedback,
    }));
    const normalizedGeneralReviews = (generalReviews || []).map(review => ({
      ...review,
      source: 'general',
      total_amount: null,
    }));

    setReviews([...normalizedOrderReviews, ...normalizedGeneralReviews].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    setLoading(false);
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price || 0) + 'đ';
  }

  function formatDateTime(dateStr) {
    return new Date(dateStr).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function getDisplayName(review) {
    const name = review.customer?.name || review.customer_name;
    return name?.trim() || 'Khách ẩn danh';
  }

  function getDisplayPhone(review) {
    return review.customer?.phone || review.customer_phone || '';
  }

  function renderStars(rating, size = 18) {
    const activeRating = Math.round(Number(rating || 0));
    return [1, 2, 3, 4, 5].map(star => (
      <Star key={star} size={size} fill={star <= activeRating ? 'currentColor' : 'none'} />
    ));
  }

  const filteredReviews = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return reviews;
    return reviews.filter(review => {
      const name = getDisplayName(review).toLowerCase();
      const phone = getDisplayPhone(review).toLowerCase();
      const feedback = (review.feedback || '').toLowerCase();
      return name.includes(term) || phone.includes(term) || feedback.includes(term);
    });
  }, [reviews, searchTerm]);

  const reviewedCount = reviews.length;
  const ratedReviews = reviews.filter(review => review.rating);
  const averageRating = ratedReviews.length
    ? ratedReviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / ratedReviews.length
    : 0;
  const anonymousCount = reviews.filter(review => !review.customer_id && !review.customer_phone && !review.customer?.phone).length;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Đánh giá khách hàng</h1>
          <p className="page-subtitle">Theo dõi sao và góp ý từ khách, bao gồm khách ẩn danh</p>
        </div>
        <button className="reviews-refresh" onClick={fetchReviews} disabled={loading}>
          <RefreshCw size={16} /> Làm mới
        </button>
      </div>

      <div className="reviews-summary">
        <div className="reviews-card">
          <div className="reviews-card-icon blue"><MessageSquare size={22} /></div>
          <div>
            <div className="reviews-value">{reviewedCount}</div>
            <div className="reviews-label">Tổng góp ý</div>
          </div>
        </div>
        <div className="reviews-card">
          <div className="reviews-card-icon yellow"><Star size={22} fill="currentColor" /></div>
          <div>
            <div className="reviews-value">{averageRating ? averageRating.toFixed(1) : '—'}</div>
            <div className="reviews-label">Sao trung bình</div>
          </div>
        </div>
        <div className="reviews-card">
          <div className="reviews-card-icon gray"><User size={22} /></div>
          <div>
            <div className="reviews-value">{anonymousCount}</div>
            <div className="reviews-label">Khách ẩn danh</div>
          </div>
        </div>
      </div>

      <div className="reviews-search">
        <Search size={16} />
        <input
          placeholder="Tìm theo tên, số điện thoại hoặc nội dung góp ý..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="reviews-empty">Đang tải đánh giá...</div>
      ) : filteredReviews.length > 0 ? (
        <div className="reviews-list">
          {filteredReviews.map(review => (
            <div key={`${review.source}-${review.id}`} className="review-item">
              <div className="review-top">
                <div className="review-customer">
                  <div className="review-avatar">{getDisplayName(review).charAt(0).toUpperCase()}</div>
                  <div>
                    <div className="review-name">{getDisplayName(review)}</div>
                    <div className="review-meta">
                      {getDisplayPhone(review) ? <span><Phone size={13} /> {getDisplayPhone(review)}</span> : <span>Không để lại SĐT</span>}
                      <span>Bàn {review.table?.table_number || '?'}</span>
                      <span>{formatDateTime(review.created_at)}</span>
                    </div>
                  </div>
                </div>
                <div className="review-total">{review.source === 'order' ? formatPrice(review.total_amount) : 'Góp ý chung'}</div>
              </div>

              <div className="review-rating">
                {review.rating ? (
                  <>
                    <div className="review-stars">{renderStars(review.rating)}</div>
                    <strong>{Number(review.rating).toFixed(1)}</strong>
                  </>
                ) : (
                  <span className="review-no-rating">Chưa chọn sao</span>
                )}
              </div>

              {review.feedback ? (
                <p className="review-feedback">“{review.feedback}”</p>
              ) : (
                <p className="review-feedback muted">Khách chỉ đánh giá sao, không nhập góp ý.</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="reviews-empty">Chưa có đánh giá phù hợp</div>
      )}
    </div>
  );
}
