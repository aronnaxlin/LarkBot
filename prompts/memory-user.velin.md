<script setup>
const props = defineProps({
  currentDate: { type: String, required: true },
})
</script>

Current date: {{ currentDate }}. Messages in the chatlog show only month, day and time; a month-day later in the year than today belongs to last year.

Update the notes from the chatlog above, following the rules in your instructions. Only people listed in `<speakers>` have a writable card. Output the JSON object and nothing else.
