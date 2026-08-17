from shipwright.parsing import parse_json


def test_bare_json():
    assert parse_json('{"a": 1}') == {"a": 1}


def test_markdown_fence():
    assert parse_json('```json\n{"intent": "change"}\n```') == {"intent": "change"}


def test_trailing_chat_tokens():
    assert parse_json('{"a": 1}<|im_end|>') == {"a": 1}


def test_prose_wrapped_braces():
    assert parse_json('Sure! Here you go: {"a": 1} hope that helps') == {"a": 1}


def test_non_dict_and_garbage_return_none():
    assert parse_json("[1, 2]") is None
    assert parse_json("not json at all") is None
    assert parse_json("") is None


def test_bare_fence_without_language_tag():
    assert parse_json('```\n{"a": 1}\n```') == {"a": 1}


def test_fenced_non_dict_returns_none():
    assert parse_json("```json\n[1, 2]\n```") is None
