import Link from 'next/link';
import { AdminMeetingMinutes } from '@/components/knowledge/admin-meeting-minutes';

export default function MeetingMinutesPage() {
  return <><nav style={{ padding: '12px 24px' }}><Link href="/admin/meeting-bot">飞书会议机器人：检查连接、入会与退出</Link></nav><AdminMeetingMinutes /></>;
}
