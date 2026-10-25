import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f5ef' },
  page: { padding: 18, paddingBottom: 60, gap: 16 },
  header: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#d2d9d0' },
  title: { fontSize: 26, fontWeight: '800', color: '#14382b' },
  heading: { fontSize: 21, fontWeight: '700', color: '#14382b' },
  text: { fontSize: 17, lineHeight: 25, color: '#25392e' },
  small: { fontSize: 14, lineHeight: 21, color: '#44564a' },
  panel: { backgroundColor: '#fff', borderColor: '#ced9cc', borderWidth: 1, borderRadius: 12, padding: 16, gap: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  button: { minHeight: 56, backgroundColor: '#17523b', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 10 },
  secondary: { backgroundColor: '#e4eee2', borderWidth: 1, borderColor: '#a2b79d' },
  danger: { backgroundColor: '#8e291c' },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  secondaryText: { color: '#14382b' },
  disabled: { opacity: 0.45 },
  field: { minHeight: 56, borderWidth: 1.5, borderColor: '#76917c', backgroundColor: '#fff', borderRadius: 8, padding: 14, color: '#172d20', fontSize: 19 },
  notice: { backgroundColor: '#fff2cb', padding: 14, borderRadius: 8, borderLeftWidth: 5, borderLeftColor: '#9a6900' },
  error: { backgroundColor: '#ffe5de', borderLeftColor: '#9a2e1d' },
  photo: { width: '100%', height: 180, borderRadius: 8, backgroundColor: '#d6dfd2' },
});

export function Page({ children }: { children: ReactNode }) {
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>{children}</ScrollView>;
}
export function Panel({ children }: { children: ReactNode }) { return <View style={styles.panel}>{children}</View>; }
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && styles.error]}><Text style={styles.text}>{children}</Text></View>;
}
export function Action({ label, onPress, disabled = false, secondary = false, danger = false, testID, icon }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; danger?: boolean; testID?: string; icon?: string }) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.button, secondary && styles.secondary, danger && styles.danger, (disabled || pressed) && styles.disabled]}>
    {icon ? <Text accessible={false} style={[styles.buttonText, secondary && styles.secondaryText]}>{icon}</Text> : null}
    <Text style={[styles.buttonText, secondary && styles.secondaryText, { flexShrink: 1 }]}>{label}</Text>
  </Pressable>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={{ gap: 6 }}><Text style={styles.text}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor="#66766b" {...props} style={[styles.field, props.multiline && { minHeight: 100, textAlignVertical: 'top' }, props.style]} /></View>;
}
export function Busy({ label }: { label: string }) { return <View style={styles.row}><ActivityIndicator color="#17523b" /><Text style={styles.text}>{label}</Text></View>; }
