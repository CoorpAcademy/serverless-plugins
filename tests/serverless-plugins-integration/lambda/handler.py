import json
from os import environ

def handler(event, context):
    print(f">> I am {environ.get('WHOAMI')}")
