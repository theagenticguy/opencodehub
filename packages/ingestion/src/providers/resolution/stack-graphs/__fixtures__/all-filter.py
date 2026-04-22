__all__ = ["public_func"]


def _helper():
    return 1


def public_func():
    return _helper()
